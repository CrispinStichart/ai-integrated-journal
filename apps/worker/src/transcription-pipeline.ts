import {
  type CapabilityResolution,
  type JsonObject,
  type RawResponseRetention,
  type SpeechToTextProvider,
} from '@journal/ai';
import {
  QueueJobError,
  TRANSCRIPTION_JOB_OPERATION,
  TranscriptionRepository,
  queueNames,
  registerQueueWorker,
  type CanonicalJobHandler,
  type CanonicalJobInput,
  type CanonicalTranscriptionInput,
  type DatabaseClient,
  type QueueJobPayload,
} from '@journal/database';
import { createUuidV7 } from '@journal/domain';
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
import {
  TRANSCRIPT_CLEANUP_CONFIGURATION,
  TRANSCRIPT_CLEANUP_PROMPT,
} from './transcript-cleanup-pipeline.js';

const RAW_RESPONSE_RETENTION = 'days_30' satisfies RawResponseRetention;
const RAW_RESPONSE_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

export type SpeechProviderResolver = () => Promise<
  CapabilityResolution<SpeechToTextProvider>
>;

class PipelineFailure extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super('Transcription pipeline failed.');
    this.name = 'PipelineFailure';
  }
}

function jsonRecord(value: object): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>;
}

function classify(error: unknown): PipelineFailure {
  if (error instanceof PipelineFailure) return error;
  if (error instanceof BlobConflictError) {
    return new PipelineFailure('raw_response_conflict', false);
  }
  if (error instanceof BlobNotFoundError) {
    return new PipelineFailure('audio_temporarily_unavailable', true);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new PipelineFailure('canceled', false);
  }
  return new PipelineFailure('provider_or_storage_failure', true);
}

async function* abortable(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for await (const bytes of stream) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    yield bytes;
  }
}

export class TranscriptionJobHandler implements CanonicalJobHandler<CanonicalTranscriptionInput> {
  readonly #repository: TranscriptionRepository;
  readonly #rawResponses: BlobRawResponseStore;

  public constructor(
    database: DatabaseClient,
    private readonly boss: PgBoss,
    private readonly blobs: BlobStore,
    private readonly resolveProvider: SpeechProviderResolver,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = () =>
      createUuidV7<'transcription-artifact'>(),
  ) {
    this.#repository = new TranscriptionRepository(database.database);
    this.#rawResponses = new BlobRawResponseStore(database.database, blobs);
  }

  public async load(
    payload: QueueJobPayload,
  ): Promise<CanonicalJobInput<CanonicalTranscriptionInput>> {
    if (
      payload.operation !== TRANSCRIPTION_JOB_OPERATION ||
      payload.identifiers.inputKey === undefined ||
      payload.identifiers.runId === undefined ||
      payload.identifiers.recordingId === undefined
    ) {
      throw new QueueJobError(
        'permanent',
        'Unsupported transcription queue payload.',
      );
    }
    const canonical = await this.#repository.load(payload.identifiers.runId);
    if (
      canonical.recording.id !== payload.identifiers.recordingId ||
      canonical.run.inputFingerprint !== payload.identifiers.inputKey
    ) {
      throw new QueueJobError(
        'permanent',
        'Transcription payload identity does not match canonical state.',
      );
    }
    if (canonical.run.status === 'succeeded') {
      return { state: 'already-complete' };
    }
    if (canonical.run.status === 'canceled') {
      return { state: 'canceled' };
    }
    if (
      canonical.recording.audioDeletedAt !== null ||
      canonical.recording.latestTranscriptionRunId !== canonical.run.id
    ) {
      await this.#repository.markCanceled(canonical.run.id, this.now());
      return { state: 'canceled' };
    }
    if (
      canonical.run.status === 'failed' &&
      canonical.run.errorRetryable !== true
    ) {
      return { state: 'already-complete' };
    }
    return { input: canonical, state: 'runnable' };
  }

  public async execute(
    canonical: CanonicalTranscriptionInput,
    signal: AbortSignal,
  ): Promise<void> {
    const runId = canonical.run.id;
    try {
      await this.#repository.markRunning(runId, this.now());
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const resolution = await this.resolveProvider();
      if (resolution.status === 'unavailable') {
        throw new PipelineFailure(resolution.reason, false);
      }
      if (
        canonical.recording.finalBlobKey === null ||
        canonical.recording.finalByteSize === null
      ) {
        throw new PipelineFailure('audio_not_durable', false);
      }
      const audio = await this.blobs.open(canonical.recording.finalBlobKey);
      const result = await resolution.port.transcribe({
        audio: {
          body: abortable(audio, signal),
          mediaType: canonical.recording.mimeType,
          byteLength: canonical.recording.finalByteSize,
        },
        context: canonical.run.requestedContext,
        configuration: canonical.run.requestedConfiguration as JsonObject,
      });
      if (
        !Number.isSafeInteger(result.operation.processingTimeMs) ||
        result.operation.processingTimeMs < 0
      ) {
        throw new PipelineFailure('invalid_provider_result', false);
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const capturedAt = this.now();
      const rawResponseId = this.createId();
      const reference = await this.#rawResponses.putImmutable({
        id: rawResponseId,
        capability: 'speech_to_text',
        capturedAt,
        response: result.rawResponse,
        operation: result.operation,
        retention: RAW_RESPONSE_RETENTION,
      });
      if (reference.state !== 'retained') {
        throw new PipelineFailure('raw_response_not_retained', false);
      }
      await this.#repository.complete(this.boss, runId, {
        transcriptId: this.createId(),
        revisionId: this.createId(),
        correctedTranscriptId: this.createId(),
        correctedRevisionId: this.createId(),
        cleanupRunId: this.createId(),
        cleanupPrompt: TRANSCRIPT_CLEANUP_PROMPT,
        cleanupConfiguration: TRANSCRIPT_CLEANUP_CONFIGURATION,
        rawResponseId,
        rawResponseBlobKey: rawResponseBlobKey('speech_to_text', rawResponseId),
        rawResponseMediaType: reference.mediaType,
        rawResponseByteSize: reference.byteLength,
        rawResponseSha256: reference.sha256,
        ...(result.rawResponse.providerRequestId === undefined
          ? {}
          : {
              rawResponseProviderRequestId:
                result.rawResponse.providerRequestId,
            }),
        rawResponseRetention: RAW_RESPONSE_RETENTION,
        rawResponseExpiresAt: new Date(
          capturedAt.getTime() + RAW_RESPONSE_RETENTION_MILLISECONDS,
        ),
        text: result.text,
        segments: result.segments.map(jsonRecord),
        language: jsonRecord(result.language),
        timingAvailability: jsonRecord(result.timingAvailability),
        effectiveContext: result.effectiveContext,
        provider: jsonRecord(result.operation.provider),
        model: jsonRecord(result.operation.model),
        effectiveConfiguration: jsonRecord(result.operation.configuration),
        processingTimeMilliseconds: BigInt(result.operation.processingTimeMs),
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof QueueJobError) throw error;
      const failure = classify(error);
      if (failure.code === 'canceled') {
        throw new QueueJobError('canceled', 'Transcription was canceled.');
      }
      await this.#repository.markFailed(
        runId,
        failure.code,
        failure.retryable,
        this.now(),
      );
      throw new QueueJobError(
        failure.retryable ? 'transient' : 'permanent',
        'Transcription attempt failed.',
      );
    }
  }
}

export async function registerTranscriptionConsumer(input: {
  readonly boss: PgBoss;
  readonly database: DatabaseClient;
  readonly blobs: BlobStore;
  readonly resolveProvider: SpeechProviderResolver;
}): Promise<string> {
  return registerQueueWorker({
    boss: input.boss,
    handler: new TranscriptionJobHandler(
      input.database,
      input.boss,
      input.blobs,
      input.resolveProvider,
    ),
    queueName: queueNames.transcription,
  });
}
