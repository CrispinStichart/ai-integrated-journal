import { createHash } from 'node:crypto';

import { createUuidV7 } from '@journal/domain';
import { and, desc, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type {
  JournalDatabase,
  JournalTransaction,
  RepositoryContext,
} from './client.js';
import { createQueueJobPayload, queueNames } from './queue-contracts.js';
import { enqueueJobInTransaction, QueueJobError } from './queue-runtime.js';
import { assembleApprovedTranscriptionContext } from './memory-repository.js';
import {
  contributions,
  journalDays,
  recordings,
  transcriptionRuns,
  transcriptRevisions,
  transcripts,
} from './schema.js';
import { inTransaction } from './transaction.js';
import {
  enqueueTranscriptCleanup,
  type CleanupPromptSnapshot,
} from './transcript-cleanup-repository.js';
import {
  canonicalTranscriptEvidenceText,
  persistTranscriptSegments,
  type PersistableTranscriptSegment,
} from './transcript-evidence-repository.js';

export const TRANSCRIPTION_JOB_OPERATION = 'transcribe_recording' as const;

export type PersistedSpeechContextItem = Readonly<{
  text: string;
  purpose: string;
  version?: string;
  memoryId?: string;
  memoryRevisionId?: string;
}>;

export type TranscriptionRunRecord = typeof transcriptionRuns.$inferSelect;
export type TranscriptionRecordingRecord = typeof recordings.$inferSelect;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class TranscriptionStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TranscriptionStateError';
  }
}

export async function enqueueTranscriptionRun(input: {
  readonly boss: PgBoss;
  readonly transaction: JournalTransaction;
  readonly recordingId: string;
  readonly requestedContext?: readonly PersistedSpeechContextItem[];
  readonly requestedConfiguration?: Readonly<Record<string, unknown>>;
  readonly retryTerminal?: boolean;
  readonly now?: Date;
  readonly createId?: () => string;
}): Promise<TranscriptionRunRecord> {
  const now = input.now ?? new Date();
  const [recording] = await input.transaction
    .select()
    .from(recordings)
    .where(eq(recordings.id, input.recordingId))
    .limit(1)
    .for('update');
  if (
    recording === undefined ||
    recording.persistenceState !== 'durable' ||
    recording.finalSha256 === null ||
    recording.finalBlobKey === null
  ) {
    throw new TranscriptionStateError(
      'Transcription requires durably confirmed audio.',
    );
  }
  if (recording.audioDeletedAt !== null) {
    throw new TranscriptionStateError(
      'Deleted audio cannot be submitted for transcription.',
    );
  }

  const [latest] = await input.transaction
    .select()
    .from(transcriptionRuns)
    .where(eq(transcriptionRuns.recordingId, recording.id))
    .orderBy(desc(transcriptionRuns.attempt))
    .limit(1)
    .for('update');

  if (latest !== undefined && input.retryTerminal !== true) return latest;
  if (
    input.retryTerminal === true &&
    (latest === undefined || !['failed', 'canceled'].includes(latest.status))
  ) {
    throw new TranscriptionStateError(
      'Only a failed or canceled transcription can be retried.',
    );
  }

  let context = input.requestedContext;
  if (context === undefined) {
    const [ownership] = await input.transaction
      .select({ ownerId: journalDays.userId })
      .from(recordings)
      .innerJoin(contributions, eq(contributions.id, recordings.contributionId))
      .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
      .where(eq(recordings.id, recording.id))
      .limit(1);
    if (ownership === undefined) {
      throw new TranscriptionStateError(
        'Recording owner could not be resolved.',
      );
    }
    context = await assembleApprovedTranscriptionContext(
      input.transaction,
      ownership.ownerId,
    );
  }
  const requestedContext = Object.freeze([...context]);
  const requestedConfiguration = Object.freeze({
    ...(input.requestedConfiguration ?? latest?.requestedConfiguration ?? {}),
  });
  const attempt = (latest?.attempt ?? 0) + 1;
  const runId = (
    input.createId ?? (() => createUuidV7<'transcription-run'>())
  )();
  const inputFingerprint = sha256(
    canonicalJson({
      audioSha256: recording.finalSha256,
      configuration: requestedConfiguration,
      context: requestedContext,
    }),
  );
  const [run] = await input.transaction
    .insert(transcriptionRuns)
    .values({
      id: runId,
      recordingId: recording.id,
      ...(latest === undefined ? {} : { predecessorRunId: latest.id }),
      attempt,
      inputAudioSha256: recording.finalSha256,
      inputFingerprint,
      requestedContext,
      requestedConfiguration,
      queuedAt: now,
      updatedAt: now,
    })
    .returning();
  if (run === undefined) {
    throw new TranscriptionStateError('Transcription run was not created.');
  }
  await input.transaction
    .update(recordings)
    .set({
      latestTranscriptionRunId: run.id,
      transcriptionState: 'queued',
      updatedAt: now,
    })
    .where(eq(recordings.id, recording.id));

  await enqueueJobInTransaction({
    boss: input.boss,
    jobId: run.id,
    payload: createQueueJobPayload({
      identifiers: {
        inputKey: inputFingerprint,
        recordingId: recording.id,
        runId: run.id,
      },
      operation: TRANSCRIPTION_JOB_OPERATION,
      queueName: queueNames.transcription,
    }),
    queueName: queueNames.transcription,
    transaction: input.transaction,
  });
  return run;
}

export type CanonicalTranscriptionInput = Readonly<{
  run: TranscriptionRunRecord;
  recording: TranscriptionRecordingRecord;
}>;

export type PersistedTranscriptionSuccess = Readonly<{
  transcriptId: string;
  revisionId: string;
  correctedTranscriptId: string;
  correctedRevisionId: string;
  cleanupRunId: string;
  cleanupPrompt: CleanupPromptSnapshot;
  cleanupConfiguration: Readonly<Record<string, unknown>>;
  rawResponseId: string;
  rawResponseBlobKey: string;
  rawResponseMediaType: string;
  rawResponseByteSize: bigint;
  rawResponseSha256: string;
  rawResponseProviderRequestId?: string;
  rawResponseRetention: 'days_30';
  rawResponseExpiresAt: Date;
  text: string;
  segments: readonly Readonly<{
    rawSegmentId: string;
    correctedSegmentId: string;
    segment: Omit<PersistableTranscriptSegment, 'id' | 'sourceSegmentId'>;
  }>[];
  language: Readonly<Record<string, unknown>>;
  timingAvailability: Readonly<Record<string, unknown>>;
  effectiveContext: readonly PersistedSpeechContextItem[];
  provider: Readonly<Record<string, unknown>>;
  model: Readonly<Record<string, unknown>>;
  effectiveConfiguration: Readonly<Record<string, unknown>>;
  processingTimeMilliseconds: bigint;
  now: Date;
}>;

export class TranscriptionRepository {
  public constructor(private readonly database: JournalDatabase) {}

  public async load(runId: string): Promise<CanonicalTranscriptionInput> {
    const [row] = await this.database
      .select({ run: transcriptionRuns, recording: recordings })
      .from(transcriptionRuns)
      .innerJoin(recordings, eq(recordings.id, transcriptionRuns.recordingId))
      .where(eq(transcriptionRuns.id, runId))
      .limit(1);
    if (row === undefined) {
      throw new QueueJobError('permanent', 'Transcription run does not exist.');
    }
    return row;
  }

  public async markRunning(runId: string, now: Date): Promise<number> {
    return inTransaction(this.database, async (transaction) => {
      const canonical = await this.lock(transaction, runId);
      if (
        canonical.recording.latestTranscriptionRunId !== runId ||
        canonical.recording.audioDeletedAt !== null
      ) {
        await this.cancelLocked(transaction, canonical, now);
        throw new QueueJobError(
          'canceled',
          'Transcription is no longer current.',
        );
      }
      const executionCount = canonical.run.executionCount + 1;
      await transaction
        .update(transcriptionRuns)
        .set({
          executionCount,
          status: 'running',
          errorCode: null,
          errorRetryable: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(transcriptionRuns.id, runId));
      await transaction
        .update(recordings)
        .set({ transcriptionState: 'running', updatedAt: now })
        .where(eq(recordings.id, canonical.recording.id));
      return executionCount;
    });
  }

  public async markFailed(
    runId: string,
    code: string,
    retryable: boolean,
    now: Date,
  ): Promise<void> {
    await inTransaction(this.database, async (transaction) => {
      const canonical = await this.lock(transaction, runId);
      if (canonical.run.status === 'succeeded') return;
      await transaction
        .update(transcriptionRuns)
        .set({
          status: 'failed',
          errorCode: code,
          errorRetryable: retryable,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(transcriptionRuns.id, runId));
      if (canonical.recording.latestTranscriptionRunId === runId) {
        await transaction
          .update(recordings)
          .set({ transcriptionState: 'failed', updatedAt: now })
          .where(eq(recordings.id, canonical.recording.id));
      }
    });
  }

  public async markCanceled(runId: string, now: Date): Promise<void> {
    await inTransaction(this.database, async (transaction) => {
      const canonical = await this.lock(transaction, runId);
      if (canonical.run.status === 'succeeded') return;
      await this.cancelLocked(transaction, canonical, now);
    });
  }

  public async complete(
    boss: PgBoss,
    runId: string,
    result: PersistedTranscriptionSuccess,
  ): Promise<void> {
    await inTransaction(this.database, async (transaction) => {
      const canonical = await this.lock(transaction, runId);
      if (canonical.run.status === 'succeeded') return;
      if (
        canonical.recording.latestTranscriptionRunId !== runId ||
        canonical.recording.audioDeletedAt !== null
      ) {
        await this.cancelLocked(transaction, canonical, result.now);
        throw new QueueJobError(
          'canceled',
          'Transcription is no longer current.',
        );
      }

      let [transcript] = await transaction
        .select()
        .from(transcripts)
        .where(
          and(
            eq(transcripts.recordingId, canonical.recording.id),
            eq(transcripts.layer, 'raw_stt'),
          ),
        )
        .limit(1)
        .for('update');
      if (transcript === undefined) {
        [transcript] = await transaction
          .insert(transcripts)
          .values({
            id: result.transcriptId,
            recordingId: canonical.recording.id,
            layer: 'raw_stt',
            createdAt: result.now,
            updatedAt: result.now,
          })
          .returning();
      }
      if (transcript === undefined) {
        throw new TranscriptionStateError('Raw transcript was not created.');
      }
      const revision = transcript.currentRevision + 1;
      const evidenceText = canonicalTranscriptEvidenceText(result.text);
      const rawSegments = result.segments.map(({ rawSegmentId, segment }) => ({
        ...segment,
        id: rawSegmentId,
      }));
      const rawSegmentJson = rawSegments.map(
        ({ providerMetadata, ...segment }) => ({
          ...segment,
          ...providerMetadata,
        }),
      );
      await transaction.insert(transcriptRevisions).values({
        id: result.revisionId,
        transcriptId: transcript.id,
        sourceRunId: runId,
        revision,
        text: result.text,
        evidenceText,
        segments: rawSegmentJson,
        language: result.language,
        timingAvailability: result.timingAvailability,
        authority: 'generated',
        contentHash: sha256(result.text),
        createdAt: result.now,
      });
      await persistTranscriptSegments({
        transaction,
        transcriptRevisionId: result.revisionId,
        evidenceText,
        segments: rawSegments,
        createdAt: result.now,
      });
      await transaction
        .update(transcripts)
        .set({
          currentRevisionId: result.revisionId,
          currentRevision: revision,
          updatedAt: result.now,
        })
        .where(eq(transcripts.id, transcript.id));

      const [existingCorrected] = await transaction
        .select()
        .from(transcripts)
        .where(
          and(
            eq(transcripts.recordingId, canonical.recording.id),
            eq(transcripts.layer, 'corrected'),
          ),
        )
        .limit(1)
        .for('update');
      if (existingCorrected === undefined) {
        const [correctedTranscript] = await transaction
          .insert(transcripts)
          .values({
            id: result.correctedTranscriptId,
            recordingId: canonical.recording.id,
            layer: 'corrected',
            createdAt: result.now,
            updatedAt: result.now,
          })
          .returning();
        if (correctedTranscript === undefined) {
          throw new TranscriptionStateError(
            'Corrected transcript was not created.',
          );
        }
        await transaction.insert(transcriptRevisions).values({
          id: result.correctedRevisionId,
          transcriptId: correctedTranscript.id,
          sourceRevisionId: result.revisionId,
          revision: 1,
          text: result.text,
          evidenceText,
          segments: result.segments.map(
            ({ rawSegmentId, correctedSegmentId, segment }) => {
              const { providerMetadata, ...metadata } = segment;
              return {
                ...metadata,
                ...providerMetadata,
                id: correctedSegmentId,
                sourceSegmentId: rawSegmentId,
              };
            },
          ),
          language: result.language,
          timingAvailability: result.timingAvailability,
          authority: 'generated',
          contentHash: sha256(result.text),
          createdAt: result.now,
        });
        await persistTranscriptSegments({
          transaction,
          transcriptRevisionId: result.correctedRevisionId,
          evidenceText,
          segments: result.segments.map(
            ({ rawSegmentId, correctedSegmentId, segment }) => ({
              ...segment,
              id: correctedSegmentId,
              sourceSegmentId: rawSegmentId,
            }),
          ),
          createdAt: result.now,
        });
        await transaction
          .update(transcripts)
          .set({
            currentRevisionId: result.correctedRevisionId,
            currentRevision: 1,
            updatedAt: result.now,
          })
          .where(eq(transcripts.id, correctedTranscript.id));
        await enqueueTranscriptCleanup({
          boss,
          transaction,
          sourceCorrectedRevisionId: result.correctedRevisionId,
          prompt: result.cleanupPrompt,
          requestedConfiguration: result.cleanupConfiguration,
          now: result.now,
          createId: () => result.cleanupRunId,
        });
      }
      await transaction
        .update(transcriptionRuns)
        .set({
          status: 'succeeded',
          effectiveContext: result.effectiveContext,
          provider: result.provider,
          model: result.model,
          effectiveConfiguration: result.effectiveConfiguration,
          processingTimeMilliseconds: result.processingTimeMilliseconds,
          language: result.language,
          timingAvailability: result.timingAvailability,
          rawResponseId: result.rawResponseId,
          rawResponseBlobKey: result.rawResponseBlobKey,
          rawResponseMediaType: result.rawResponseMediaType,
          rawResponseByteSize: result.rawResponseByteSize,
          rawResponseSha256: result.rawResponseSha256,
          rawResponseProviderRequestId:
            result.rawResponseProviderRequestId ?? null,
          rawResponseRetention: result.rawResponseRetention,
          rawResponseExpiresAt: result.rawResponseExpiresAt,
          errorCode: null,
          errorRetryable: null,
          completedAt: result.now,
          updatedAt: result.now,
        })
        .where(eq(transcriptionRuns.id, runId));
      await transaction
        .update(recordings)
        .set({ transcriptionState: 'succeeded', updatedAt: result.now })
        .where(eq(recordings.id, canonical.recording.id));
    });
  }

  private async lock(
    transaction: JournalTransaction,
    runId: string,
  ): Promise<CanonicalTranscriptionInput> {
    const [row] = await transaction
      .select({ run: transcriptionRuns, recording: recordings })
      .from(transcriptionRuns)
      .innerJoin(recordings, eq(recordings.id, transcriptionRuns.recordingId))
      .where(eq(transcriptionRuns.id, runId))
      .limit(1)
      .for('update');
    if (row === undefined) {
      throw new QueueJobError('permanent', 'Transcription run does not exist.');
    }
    return row;
  }

  private async cancelLocked(
    transaction: RepositoryContext,
    canonical: CanonicalTranscriptionInput,
    now: Date,
  ): Promise<void> {
    await transaction
      .update(transcriptionRuns)
      .set({ status: 'canceled', completedAt: now, updatedAt: now })
      .where(eq(transcriptionRuns.id, canonical.run.id));
    if (canonical.recording.latestTranscriptionRunId === canonical.run.id) {
      await transaction
        .update(recordings)
        .set({ transcriptionState: 'failed', updatedAt: now })
        .where(eq(recordings.id, canonical.recording.id));
    }
  }
}
