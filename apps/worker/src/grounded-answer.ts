import { createHash } from 'node:crypto';

import type {
  CapabilityResolution,
  JsonObject,
  JsonValue,
  RawResponseRetention,
  StructuredGenerationProvider,
  StructuredOutputSchema,
} from '@journal/ai';
import {
  GROUNDED_ANSWER_CONFIGURATION,
  GROUNDED_ANSWER_OPERATION,
  GroundedAnswerRepository,
  QueueJobError,
  queueNames,
  registerQueueWorker,
  type CanonicalGroundedAnswerInput,
  type CanonicalJobHandler,
  type CanonicalJobInput,
  type DatabaseClient,
  type QueueJobPayload,
} from '@journal/database';
import {
  GROUNDED_ANSWER_OUTPUT_JSON_SCHEMA,
  createUuidV7,
  groundedAnswerMessages,
  validateGroundedAnswerOutput,
} from '@journal/domain';
import type { BlobStore } from '@journal/storage';
import type { PgBoss } from 'pg-boss';

import {
  BlobRawResponseStore,
  rawResponseBlobKey,
} from './raw-response-store.js';

const RAW_RESPONSE_RETENTION = 'days_30' satisfies RawResponseRetention;
const RAW_RESPONSE_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

export type GroundedAnswerProviderResolver = (
  canonical: CanonicalGroundedAnswerInput,
) => Promise<CapabilityResolution<StructuredGenerationProvider>>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Provider lineage must be a JSON object.');
  return value as Readonly<Record<string, unknown>>;
}

export class GroundedAnswerJobHandler implements CanonicalJobHandler<CanonicalGroundedAnswerInput> {
  readonly #repository: GroundedAnswerRepository;
  readonly #rawResponses: BlobRawResponseStore;

  public constructor(
    database: DatabaseClient,
    blobs: BlobStore,
    private readonly resolveProvider: GroundedAnswerProviderResolver,
    repository: GroundedAnswerRepository = new GroundedAnswerRepository(
      database.database,
    ),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = () =>
      createUuidV7<'grounded-answer-raw-response'>(),
  ) {
    this.#repository = repository;
    this.#rawResponses = new BlobRawResponseStore(database.database, blobs);
  }

  public async load(
    payload: QueueJobPayload,
  ): Promise<CanonicalJobInput<CanonicalGroundedAnswerInput>> {
    const answerId = payload.identifiers.answerId;
    const ownerId = payload.identifiers.ownerId;
    if (
      payload.operation !== GROUNDED_ANSWER_OPERATION ||
      answerId === undefined ||
      ownerId === undefined ||
      Object.keys(payload.identifiers).sort().join(',') !== 'answerId,ownerId'
    ) {
      throw new QueueJobError(
        'permanent',
        'Unsupported grounded-answer payload.',
      );
    }
    const canonical = await this.#repository.loadCanonical(answerId);
    if (canonical === undefined || canonical.answer.ownerId !== ownerId)
      return { state: 'canceled' };
    if (
      canonical.answer.status === 'succeeded' ||
      canonical.answer.status === 'insufficient_support'
    )
      return { state: 'already-complete' };
    if (canonical.answer.jobId === null) return { state: 'canceled' };
    return { state: 'runnable', input: canonical };
  }

  public async execute(
    canonical: CanonicalGroundedAnswerInput,
    signal: AbortSignal,
  ): Promise<void> {
    const { answer } = canonical;
    if (canonical.citations.length === 0) {
      await this.#repository.markInsufficient(answer.id, this.now());
      return;
    }
    if (
      !(await this.#repository.markRunning(
        answer.id,
        answer.jobId as string,
        this.now(),
      ))
    )
      return;
    try {
      const resolution = await this.resolveProvider(canonical);
      if (resolution.status === 'unavailable') {
        await this.#repository.markFailed(
          answer.id,
          `capability_unavailable:${resolution.reason}`,
          this.now(),
        );
        return;
      }
      if (signal.aborted) signal.throwIfAborted();
      const messages = groundedAnswerMessages({
        question: answer.question,
        fragments: canonical.citations.map((citation) => ({
          citationId: citation.citationId,
          layer: citation.layer,
          sourceRevisionId: citation.sourceRevisionId,
          ...(citation.journalDate === null
            ? {}
            : { journalDate: citation.journalDate }),
          text: citation.retrievedQuote,
        })),
      });
      const allowedCitationIds = new Set(
        canonical.citations.map(({ citationId }) => citationId),
      );
      const outputSchema: StructuredOutputSchema<JsonValue> = {
        id: 'grounded-answer.output',
        version: '1.0.0',
        jsonSchema: GROUNDED_ANSWER_OUTPUT_JSON_SCHEMA as JsonObject,
        parse: (value) =>
          validateGroundedAnswerOutput(value, allowedCitationIds) as JsonValue,
      };
      const result = await resolution.port.generate({
        messages,
        outputSchema,
        prompt: {
          id: answer.promptId,
          version: answer.promptVersion,
          templateHash: answer.promptTemplateHash,
        },
        configuration: GROUNDED_ANSWER_CONFIGURATION,
      });
      const output = validateGroundedAnswerOutput(
        result.data,
        allowedCitationIds,
      );
      if (
        !Number.isSafeInteger(result.operation.processingTimeMs) ||
        result.operation.processingTimeMs < 0
      )
        throw new TypeError('Provider processing time is invalid.');
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
        throw new TypeError('Grounded-answer raw response was not retained.');
      await this.#repository.complete({
        answerId: answer.id,
        status:
          output.status === 'answered' ? 'succeeded' : 'insufficient_support',
        ...(output.status === 'answered' ? { synthesis: output.answer } : {}),
        citationIds: output.citationIds,
        effectiveMessagesHash: hashJson(result.effectiveMessages),
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
        now: capturedAt,
      });
    } catch (error) {
      const permanent =
        error instanceof TypeError || error instanceof RangeError;
      await this.#repository.markFailed(
        answer.id,
        error instanceof Error ? error.name : 'UnknownError',
        this.now(),
      );
      throw new QueueJobError(
        permanent ? 'permanent' : 'transient',
        'Grounded-answer generation failed.',
      );
    }
  }
}

export function registerGroundedAnswerConsumer(input: {
  readonly boss: PgBoss;
  readonly database: DatabaseClient;
  readonly blobs: BlobStore;
  readonly resolveProvider: GroundedAnswerProviderResolver;
}): Promise<string> {
  return registerQueueWorker({
    boss: input.boss,
    queueName: queueNames.groundedAnswers,
    handler: new GroundedAnswerJobHandler(
      input.database,
      input.blobs,
      input.resolveProvider,
    ),
  });
}
