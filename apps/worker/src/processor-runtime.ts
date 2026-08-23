import { createHash } from 'node:crypto';

import {
  type CapabilityResolution,
  type JsonObject,
  type JsonValue,
  type RawResponseRetention,
  type StructuredGenerationProvider,
  type StructuredOutputSchema,
} from '@journal/ai';
import {
  PROCESSOR_JOB_OPERATION,
  ProcessorRuntimeRepository,
  QueueJobError,
  queueNames,
  registerQueueWorker,
  type CanonicalJobHandler,
  type CanonicalJobInput,
  type CanonicalProcessorRunInput,
  type DatabaseClient,
  type QueueJobPayload,
} from '@journal/database';
import { createUuidV7, DomainInvariantError } from '@journal/domain';
import {
  FoodAndDrinkValidationError,
  MoodValidationError,
  ProcessorRuntimeValidationError,
  SleepAndTemporalValidationError,
  processorGenerationMessages,
  processorOutputJsonSchema,
  validateProcessorOutput,
  type ProposedProcessorOutput,
  validateBuiltInProcessorOutput,
} from '@journal/processors';
import {
  BlobConflictError,
  BlobNotFoundError,
  type BlobStore,
} from '@journal/storage';
import type { PgBoss } from 'pg-boss';

import {
  BlobRawResponseStore,
  rawResponseBlobKey,
} from './raw-response-store.js';

const RAW_RESPONSE_RETENTION = 'days_30' satisfies RawResponseRetention;
const RAW_RESPONSE_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

export type ProcessorStructuredProviderResolver = (
  canonical: CanonicalProcessorRunInput,
) => Promise<CapabilityResolution<StructuredGenerationProvider>>;

export type DeterministicProcessor = (
  canonical: CanonicalProcessorRunInput,
  signal: AbortSignal,
) => ProposedProcessorOutput | Promise<ProposedProcessorOutput>;

export type DeterministicProcessorResolver = (
  processorVersionId: string,
) => DeterministicProcessor | undefined;

class ProcessorPipelineFailure extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super('Processor runtime failed.');
    this.name = 'ProcessorPipelineFailure';
  }
}

function classify(error: unknown): ProcessorPipelineFailure {
  if (error instanceof ProcessorPipelineFailure) return error;
  if (
    error instanceof ProcessorRuntimeValidationError ||
    error instanceof FoodAndDrinkValidationError ||
    error instanceof MoodValidationError ||
    error instanceof SleepAndTemporalValidationError ||
    error instanceof DomainInvariantError ||
    error instanceof TypeError
  )
    return new ProcessorPipelineFailure(
      error instanceof ProcessorRuntimeValidationError
        ? error.code
        : error instanceof FoodAndDrinkValidationError ||
            error instanceof MoodValidationError ||
            error instanceof SleepAndTemporalValidationError
          ? error.code
          : error instanceof DomainInvariantError
            ? 'invalid_reconciliation_output'
            : 'invalid_provider_result',
      false,
    );
  if (error instanceof BlobConflictError)
    return new ProcessorPipelineFailure('raw_response_conflict', false);
  if (error instanceof BlobNotFoundError)
    return new ProcessorPipelineFailure(
      'storage_temporarily_unavailable',
      true,
    );
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return new ProcessorPipelineFailure('runtime_timeout', true);
  if (error instanceof Error && error.name === 'AbortError')
    return new ProcessorPipelineFailure('canceled', false);
  return new ProcessorPipelineFailure('provider_or_storage_failure', true);
}

function jsonRecord(value: object): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', aborted);
    });
  });
}

export class ProcessorJobHandler implements CanonicalJobHandler<CanonicalProcessorRunInput> {
  readonly #repository: ProcessorRuntimeRepository;
  readonly #rawResponses: BlobRawResponseStore;

  public constructor(
    database: DatabaseClient,
    blobs: BlobStore,
    private readonly resolveProvider: ProcessorStructuredProviderResolver,
    private readonly resolveDeterministic: DeterministicProcessorResolver = () =>
      undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = () =>
      createUuidV7<'processor-runtime'>(),
    boss?: PgBoss,
  ) {
    this.#repository = new ProcessorRuntimeRepository(database.database, boss);
    this.#rawResponses = new BlobRawResponseStore(database.database, blobs);
  }

  public async load(
    payload: QueueJobPayload,
  ): Promise<CanonicalJobInput<CanonicalProcessorRunInput>> {
    if (
      payload.operation !== PROCESSOR_JOB_OPERATION ||
      payload.identifiers.runId === undefined ||
      payload.identifiers.inputKey === undefined ||
      payload.identifiers.processorVersionId === undefined
    )
      throw new QueueJobError(
        'permanent',
        'Unsupported processor queue payload.',
      );
    let canonical: CanonicalProcessorRunInput;
    try {
      canonical = await this.#repository.load(payload.identifiers.runId);
    } catch (error) {
      if (error instanceof QueueJobError && error.disposition === 'canceled') {
        await this.#repository.markCanceled(
          payload.identifiers.runId,
          this.now(),
        );
      }
      throw error;
    }
    if (
      canonical.run.inputFingerprint !== payload.identifiers.inputKey ||
      canonical.run.processorVersionId !==
        payload.identifiers.processorVersionId
    )
      throw new QueueJobError(
        'permanent',
        'Processor payload identity does not match canonical state.',
      );
    if (
      canonical.run.status === 'succeeded' ||
      (canonical.run.status === 'failed' &&
        canonical.run.errorRetryable !== true)
    )
      return { state: 'already-complete' };
    if (canonical.run.status === 'canceled') return { state: 'canceled' };
    return { input: canonical, state: 'runnable' };
  }

  public async execute(
    canonical: CanonicalProcessorRunInput,
    queueSignal: AbortSignal,
  ): Promise<void> {
    const runId = canonical.run.id;
    try {
      if (!(await this.#repository.markRunning(runId, this.now())))
        throw new QueueJobError(
          'canceled',
          'Processor run became ineligible before execution.',
        );
      const timeoutSignal = AbortSignal.timeout(
        canonical.definition.resourceLimits.maxRuntimeMs,
      );
      const signal = AbortSignal.any([queueSignal, timeoutSignal]);
      if (signal.aborted) signal.throwIfAborted();
      const messages = processorGenerationMessages({
        definition: canonical.definition,
        bundle: canonical.bundle,
      });
      const deterministic =
        canonical.definition.capabilityRequirements.includes('deterministic');
      let proposed: unknown;
      let effectiveMessages: unknown = messages;
      let providerLineage: Readonly<{
        provider?: Readonly<Record<string, unknown>>;
        model?: Readonly<Record<string, unknown>>;
        effectiveConfiguration?: Readonly<Record<string, unknown>>;
        usage?: Readonly<Record<string, unknown>>;
        processingTimeMilliseconds: bigint;
        rawResponse?: Readonly<{
          id: string;
          blobKey: string;
          mediaType: string;
          byteSize: bigint;
          sha256: string;
          providerRequestId?: string;
          retention: string;
          expiresAt: Date;
        }>;
      }>;
      if (deterministic) {
        const implementation = this.resolveDeterministic(
          canonical.run.processorVersionId,
        );
        if (implementation === undefined)
          throw new ProcessorPipelineFailure(
            'deterministic_implementation_unavailable',
            false,
          );
        proposed = await withAbort(
          Promise.resolve(implementation(canonical, signal)),
          signal,
        );
        providerLineage = {
          provider: {
            id: 'deterministic',
            displayName: 'Local deterministic processor',
          },
          model: { id: canonical.run.processorVersionId },
          effectiveConfiguration: {},
          usage: { status: 'unknown' },
          processingTimeMilliseconds: 0n,
        };
      } else {
        if (
          !canonical.definition.capabilityRequirements.includes(
            'structured_generation',
          )
        )
          throw new ProcessorPipelineFailure('capability_not_supported', false);
        const resolution = await this.resolveProvider(canonical);
        if (resolution.status === 'unavailable')
          throw new ProcessorPipelineFailure(resolution.reason, false);
        const schema: StructuredOutputSchema<JsonValue> = {
          id: `processor.${canonical.run.processorVersionId}.output`,
          version: canonical.definition.outputSchemaVersion,
          jsonSchema: processorOutputJsonSchema(canonical.definition),
          parse: (value: unknown) => {
            validateProcessorOutput({
              definition: canonical.definition,
              bundle: canonical.bundle,
              sources: canonical.sources,
              output: value,
            });
            return value as JsonValue;
          },
        };
        const result = await withAbort(
          resolution.port.generate({
            messages,
            outputSchema: schema,
            prompt: {
              id: canonical.run.processorVersionId,
              version: canonical.definition.semanticVersion,
              templateHash: canonical.run.promptTemplateHash,
            },
            configuration: canonical.run.requestedConfiguration as JsonObject,
          }),
          signal,
        );
        if (
          !Number.isSafeInteger(result.operation.processingTimeMs) ||
          result.operation.processingTimeMs < 0
        )
          throw new ProcessorPipelineFailure('invalid_provider_result', false);
        proposed = result.data;
        effectiveMessages = result.effectiveMessages;
        if (signal.aborted) signal.throwIfAborted();
        const capturedAt = this.now();
        const rawResponseId = this.createId();
        const reference = await this.#rawResponses.putImmutable({
          id: rawResponseId,
          capability: 'structured_generation',
          capturedAt,
          response: result.rawResponse,
          operation: result.operation,
          retention: RAW_RESPONSE_RETENTION,
        });
        if (reference.state !== 'retained')
          throw new ProcessorPipelineFailure(
            'raw_response_not_retained',
            false,
          );
        providerLineage = {
          provider: jsonRecord(result.operation.provider),
          model: jsonRecord(result.operation.model),
          effectiveConfiguration: jsonRecord(result.operation.configuration),
          usage: jsonRecord(result.usage),
          processingTimeMilliseconds: BigInt(result.operation.processingTimeMs),
          rawResponse: {
            id: rawResponseId,
            blobKey: rawResponseBlobKey('structured_generation', rawResponseId),
            mediaType: reference.mediaType,
            byteSize: reference.byteLength,
            sha256: reference.sha256,
            ...(result.rawResponse.providerRequestId === undefined
              ? {}
              : { providerRequestId: result.rawResponse.providerRequestId }),
            retention: RAW_RESPONSE_RETENTION,
            expiresAt: new Date(
              capturedAt.getTime() + RAW_RESPONSE_RETENTION_MILLISECONDS,
            ),
          },
        };
      }
      const output = validateProcessorOutput({
        definition: canonical.definition,
        bundle: canonical.bundle,
        sources: canonical.sources,
        output: proposed,
      });
      validateBuiltInProcessorOutput(canonical.processor.key, output);
      await this.#repository.complete({
        runId,
        resultId: this.createId(),
        output,
        effectiveMessagesHash: hashJson(effectiveMessages),
        ...providerLineage,
        now: this.now(),
        createId: this.createId,
      });
    } catch (error) {
      if (error instanceof QueueJobError) throw error;
      const failure = classify(error);
      if (failure.code === 'canceled') {
        await this.#repository.markCanceled(runId, this.now());
        throw new QueueJobError('canceled', 'Processor run was canceled.');
      }
      await this.#repository.markFailed(
        runId,
        failure.code,
        failure.retryable,
        this.now(),
      );
      throw new QueueJobError(
        failure.retryable ? 'transient' : 'permanent',
        'Processor attempt failed.',
      );
    }
  }
}

export async function registerProcessorConsumer(input: {
  readonly boss: PgBoss;
  readonly database: DatabaseClient;
  readonly blobs: BlobStore;
  readonly resolveProvider: ProcessorStructuredProviderResolver;
  readonly resolveDeterministic?: DeterministicProcessorResolver;
}): Promise<string> {
  return registerQueueWorker({
    boss: input.boss,
    queueName: queueNames.processing,
    handler: new ProcessorJobHandler(
      input.database,
      input.blobs,
      input.resolveProvider,
      input.resolveDeterministic,
      undefined,
      undefined,
      input.boss,
    ),
  });
}
