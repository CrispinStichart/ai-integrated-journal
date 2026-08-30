import type { CapabilityResolution, EmbeddingProvider } from '@journal/ai';
import {
  AiProviderOperationError,
  SEMANTIC_SEARCH_EMBEDDING_CONFIGURATION,
} from '@journal/ai';
import {
  EMBEDDING_CHUNKS_PER_JOB,
  QueueJobError,
  SEARCH_EMBEDDING_DISPATCH_OPERATION,
  SEARCH_EMBEDDING_DISPATCH_SCHEDULE_KEY,
  SEARCH_EMBEDDING_OPERATION,
  SearchEmbeddingRepository,
  queueNames,
  registerQueueWorker,
  type CanonicalJobHandler,
  type CanonicalJobInput,
  type DatabaseClient,
  type PersistedEmbeddingCohort,
  type QueueJobPayload,
  type SearchEmbeddingRequestRecord,
} from '@journal/database';
import { embeddingCohortKey, validateEmbeddingVector } from '@journal/domain';
import type { PgBoss } from 'pg-boss';

export type EmbeddingProviderResolver = () => Promise<
  CapabilityResolution<EmbeddingProvider>
>;

type SearchEmbeddingJobInput =
  | Readonly<{ kind: 'dispatch' }>
  | Readonly<{
      kind: 'embed';
      jobId: string;
      request: SearchEmbeddingRequestRecord;
    }>;

class InvalidEmbeddingResultError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidEmbeddingResultError';
  }
}

function persistedCohort(
  result: Awaited<ReturnType<EmbeddingProvider['embed']>>,
): PersistedEmbeddingCohort {
  const cohort = {
    providerId: result.operation.provider.id,
    providerDisplayName: result.operation.provider.displayName,
    ...(result.operation.provider.adapterVersion === undefined
      ? {}
      : {
          providerAdapterVersion: result.operation.provider.adapterVersion,
        }),
    modelId: result.operation.model.id,
    ...(result.operation.model.displayName === undefined
      ? {}
      : { modelDisplayName: result.operation.model.displayName }),
    ...(result.operation.model.version === undefined
      ? {}
      : { modelVersion: result.operation.model.version }),
    dimension: result.dimension,
    configuration: result.operation.configuration.parameters,
    configurationFingerprint: result.operation.configuration.fingerprint,
  };
  embeddingCohortKey(cohort);
  return cohort;
}

/** Reloads every fragment from PostgreSQL; queue payloads contain identifiers only. */
export class SearchEmbeddingJobHandler implements CanonicalJobHandler<SearchEmbeddingJobInput> {
  readonly #repository: SearchEmbeddingRepository;

  public constructor(
    database: DatabaseClient,
    private readonly boss: PgBoss,
    private readonly resolveProvider: EmbeddingProviderResolver,
    repository: SearchEmbeddingRepository = new SearchEmbeddingRepository(
      database.database,
    ),
  ) {
    this.#repository = repository;
  }

  public async load(
    payload: QueueJobPayload,
  ): Promise<CanonicalJobInput<SearchEmbeddingJobInput>> {
    if (
      payload.operation === SEARCH_EMBEDDING_DISPATCH_OPERATION &&
      payload.identifiers.scheduleKey === SEARCH_EMBEDDING_DISPATCH_SCHEDULE_KEY
    ) {
      return { state: 'runnable', input: { kind: 'dispatch' } };
    }
    const fragmentId = payload.identifiers.fragmentId;
    const requestId = payload.identifiers.requestId;
    const generationKey = payload.identifiers.generationKey;
    if (
      payload.operation !== SEARCH_EMBEDDING_OPERATION ||
      fragmentId === undefined ||
      requestId !== fragmentId ||
      generationKey === undefined
    ) {
      throw new QueueJobError(
        'permanent',
        'Unsupported search embedding payload.',
      );
    }
    const request = await this.#repository.load(fragmentId);
    if (request === undefined) return { state: 'canceled' };
    if (String(request.generation) !== generationKey)
      return { state: 'canceled' };
    if (request.status === 'succeeded' || request.status === 'unavailable') {
      return { state: 'already-complete' };
    }
    if (
      request.jobId === null ||
      !['dispatched', 'running', 'failed'].includes(request.status)
    ) {
      return { state: 'canceled' };
    }
    return {
      state: 'runnable',
      input: { kind: 'embed', jobId: request.jobId, request },
    };
  }

  public async execute(
    input: SearchEmbeddingJobInput,
    signal: AbortSignal,
  ): Promise<void> {
    if (input.kind === 'dispatch') {
      await this.#repository.dispatchPending(this.boss);
      return;
    }
    const { request, jobId } = input;
    try {
      const claimed = await this.#repository.markRunning(
        request.fragmentId,
        request.generation,
        jobId,
      );
      if (!claimed) return;
      const resolution = await this.resolveProvider();
      if (resolution.status === 'unavailable') {
        await this.#repository.markUnavailable(
          request.fragmentId,
          request.generation,
          jobId,
          resolution.reason,
        );
        return;
      }

      let nextCharacter = request.nextCharacter;
      let nextChunkIndex = request.nextChunkIndex;
      for (
        let processed = 0;
        processed < EMBEDDING_CHUNKS_PER_JOB &&
        nextCharacter <= request.contentCharacters;
        processed += 1
      ) {
        if (signal.aborted) signal.throwIfAborted();
        const chunk = await this.#repository.readChunk(
          request.fragmentId,
          nextCharacter,
          nextChunkIndex,
        );
        if (chunk === undefined) break;
        const embeddingId = `${request.fragmentId}:${String(chunk.chunkIndex)}`;
        const result = await resolution.port.embed({
          fragments: [{ id: embeddingId, text: chunk.text }],
          configuration: SEMANTIC_SEARCH_EMBEDDING_CONFIGURATION,
        });
        const embedding = result.embeddings[0];
        if (
          result.embeddings.length !== 1 ||
          embedding?.fragmentId !== embeddingId
        ) {
          throw new InvalidEmbeddingResultError(
            'Embedding provider returned mismatched fragment identities.',
          );
        }
        const vector = validateEmbeddingVector(
          embedding.vector,
          result.dimension,
        );
        await this.#repository.persistChunk({
          request,
          jobId,
          cohort: persistedCohort(result),
          chunk,
          vector,
        });
        nextCharacter = chunk.endCharacter + 1;
        nextChunkIndex = chunk.chunkIndex + 1;
      }
      if (nextCharacter > request.contentCharacters) {
        await this.#repository.markSucceeded(
          request.fragmentId,
          request.generation,
          jobId,
        );
      } else {
        await this.#repository.markPendingContinuation(
          request.fragmentId,
          request.generation,
          jobId,
        );
      }
    } catch (error) {
      await this.#repository.markFailed(
        request.fragmentId,
        request.generation,
        jobId,
        error instanceof AiProviderOperationError
          ? error.code
          : error instanceof Error
            ? error.name
            : 'UnknownError',
      );
      throw new QueueJobError(
        error instanceof AiProviderOperationError
          ? error.retryable
            ? 'transient'
            : 'permanent'
          : error instanceof InvalidEmbeddingResultError ||
              error instanceof RangeError
            ? 'permanent'
            : 'transient',
        'Search embedding operation failed.',
      );
    }
  }
}

export function registerSearchEmbeddingConsumer(input: {
  readonly boss: PgBoss;
  readonly database: DatabaseClient;
  readonly resolveProvider: EmbeddingProviderResolver;
}): Promise<string> {
  return registerQueueWorker({
    boss: input.boss,
    queueName: queueNames.search,
    handler: new SearchEmbeddingJobHandler(
      input.database,
      input.boss,
      input.resolveProvider,
    ),
  });
}
