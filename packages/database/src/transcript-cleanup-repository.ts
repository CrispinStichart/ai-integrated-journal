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
import {
  transcriptCleanupRuns,
  transcriptRevisions,
  transcripts,
} from './schema.js';
import { inTransaction } from './transaction.js';
import {
  canonicalTranscriptEvidenceText,
  invalidateTranscriptRevisionDependents,
} from './transcript-evidence-repository.js';

export const TRANSCRIPT_CLEANUP_JOB_OPERATION = 'clean_transcript';

export type TranscriptCleanupRunRecord =
  typeof transcriptCleanupRuns.$inferSelect;
export type TranscriptRevisionRecord = typeof transcriptRevisions.$inferSelect;
export type TranscriptRecord = typeof transcripts.$inferSelect;

export type CleanupPromptSnapshot = Readonly<{
  id: string;
  version: string;
  templateHash: string;
}>;

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

export class TranscriptCleanupStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TranscriptCleanupStateError';
  }
}

export class TranscriptRevisionConflictError extends Error {
  public constructor(
    public readonly expectedRevisionId: string,
    public readonly actualRevisionId: string,
  ) {
    super('The corrected transcript has changed.');
    this.name = 'TranscriptRevisionConflictError';
  }
}

export async function enqueueTranscriptCleanup(input: {
  readonly boss: PgBoss;
  readonly transaction: JournalTransaction;
  readonly sourceCorrectedRevisionId: string;
  readonly prompt: CleanupPromptSnapshot;
  readonly requestedConfiguration?: Readonly<Record<string, unknown>>;
  readonly retryTerminal?: boolean;
  readonly now?: Date;
  readonly createId?: () => string;
}): Promise<TranscriptCleanupRunRecord> {
  const now = input.now ?? new Date();
  const [source] = await input.transaction
    .select({ revision: transcriptRevisions, transcript: transcripts })
    .from(transcriptRevisions)
    .innerJoin(
      transcripts,
      eq(transcripts.id, transcriptRevisions.transcriptId),
    )
    .where(eq(transcriptRevisions.id, input.sourceCorrectedRevisionId))
    .limit(1)
    .for('update');
  if (source === undefined || source.transcript.layer !== 'corrected') {
    throw new TranscriptCleanupStateError(
      'Cleanup requires an exact corrected transcript revision.',
    );
  }
  if (source.transcript.currentRevisionId !== source.revision.id) {
    throw new TranscriptCleanupStateError(
      'Cleanup can only be queued for the current corrected revision.',
    );
  }

  const [latest] = await input.transaction
    .select()
    .from(transcriptCleanupRuns)
    .where(
      eq(transcriptCleanupRuns.sourceCorrectedRevisionId, source.revision.id),
    )
    .orderBy(desc(transcriptCleanupRuns.attempt))
    .limit(1);
  if (latest !== undefined && !input.retryTerminal) return latest;
  if (
    latest !== undefined &&
    latest.status !== 'failed' &&
    latest.status !== 'canceled'
  ) {
    throw new TranscriptCleanupStateError(
      'Only a failed or canceled cleanup can be retried.',
    );
  }

  const attempt = (latest?.attempt ?? 0) + 1;
  const requestedConfiguration =
    input.requestedConfiguration ?? latest?.requestedConfiguration ?? {};
  if (
    latest !== undefined &&
    (latest.promptId !== input.prompt.id ||
      latest.promptVersion !== input.prompt.version ||
      latest.promptTemplateHash !== input.prompt.templateHash ||
      canonicalJson(requestedConfiguration) !==
        canonicalJson(latest.requestedConfiguration))
  ) {
    throw new TranscriptCleanupStateError(
      'A cleanup retry must preserve its prompt and configuration.',
    );
  }
  const inputFingerprint = sha256(
    canonicalJson({
      sourceRevisionId: source.revision.id,
      sourceContentHash: source.revision.contentHash,
      prompt: input.prompt,
      configuration: requestedConfiguration,
    }),
  );
  const runId = (input.createId ?? (() => createUuidV7<'cleanup-run'>()))();
  const [run] = await input.transaction
    .insert(transcriptCleanupRuns)
    .values({
      id: runId,
      recordingId: source.transcript.recordingId,
      sourceCorrectedRevisionId: source.revision.id,
      ...(latest === undefined ? {} : { predecessorRunId: latest.id }),
      attempt,
      inputFingerprint,
      promptId: input.prompt.id,
      promptVersion: input.prompt.version,
      promptTemplateHash: input.prompt.templateHash,
      requestedConfiguration,
      queuedAt: now,
      updatedAt: now,
    })
    .returning();
  if (run === undefined) {
    throw new TranscriptCleanupStateError('Cleanup run was not created.');
  }
  await enqueueJobInTransaction({
    boss: input.boss,
    jobId: run.id,
    payload: createQueueJobPayload({
      identifiers: {
        cleanupRunId: run.id,
        inputKey: run.inputFingerprint,
        sourceRevisionId: source.revision.id,
      },
      operation: TRANSCRIPT_CLEANUP_JOB_OPERATION,
      queueName: queueNames.cleanup,
    }),
    queueName: queueNames.cleanup,
    transaction: input.transaction,
  });
  return run;
}

export async function appendCorrectedTranscriptRevision(input: {
  readonly boss: PgBoss;
  readonly database: JournalDatabase;
  readonly transcriptId: string;
  readonly expectedRevisionId: string;
  readonly authorId: string;
  readonly text: string;
  readonly editReason?: string;
  readonly prompt: CleanupPromptSnapshot;
  readonly cleanupConfiguration?: Readonly<Record<string, unknown>>;
  readonly now?: Date;
  readonly createId?: () => string;
}): Promise<
  Readonly<{
    revision: TranscriptRevisionRecord;
    cleanupRun: TranscriptCleanupRunRecord;
  }>
> {
  const now = input.now ?? new Date();
  const createId =
    input.createId ?? (() => createUuidV7<'transcript-artifact'>());
  return inTransaction(input.database, async (transaction) => {
    const [current] = await transaction
      .select({ transcript: transcripts, revision: transcriptRevisions })
      .from(transcripts)
      .innerJoin(
        transcriptRevisions,
        eq(transcriptRevisions.id, transcripts.currentRevisionId),
      )
      .where(eq(transcripts.id, input.transcriptId))
      .limit(1)
      .for('update');
    if (current === undefined || current.transcript.layer !== 'corrected') {
      throw new TranscriptCleanupStateError(
        'Corrected transcript does not exist.',
      );
    }
    if (current.revision.id !== input.expectedRevisionId) {
      throw new TranscriptRevisionConflictError(
        input.expectedRevisionId,
        current.revision.id,
      );
    }
    await invalidateTranscriptRevisionDependents({
      transaction,
      sourceRevisionId: current.revision.id,
      now,
    });
    const revisionId = createId();
    const evidenceText = canonicalTranscriptEvidenceText(input.text);
    const [revision] = await transaction
      .insert(transcriptRevisions)
      .values({
        id: revisionId,
        transcriptId: current.transcript.id,
        sourceRevisionId: current.revision.id,
        revision: current.transcript.currentRevision + 1,
        text: input.text,
        evidenceText,
        segments: [],
        language: current.revision.language,
        timingAvailability: { segments: 'unknown', words: 'unknown' },
        authority: 'manual',
        authorId: input.authorId,
        ...(input.editReason === undefined
          ? {}
          : { editReason: input.editReason }),
        contentHash: sha256(input.text),
        createdAt: now,
      })
      .returning();
    if (revision === undefined) {
      throw new TranscriptCleanupStateError(
        'Corrected transcript revision was not created.',
      );
    }
    await transaction
      .update(transcripts)
      .set({
        currentRevisionId: revision.id,
        currentRevision: revision.revision,
        updatedAt: now,
      })
      .where(eq(transcripts.id, current.transcript.id));
    const cleanupRun = await enqueueTranscriptCleanup({
      boss: input.boss,
      transaction,
      sourceCorrectedRevisionId: revision.id,
      prompt: input.prompt,
      ...(input.cleanupConfiguration === undefined
        ? {}
        : { requestedConfiguration: input.cleanupConfiguration }),
      now,
      createId,
    });
    return Object.freeze({ revision, cleanupRun });
  });
}

export type CanonicalTranscriptCleanupInput = Readonly<{
  run: TranscriptCleanupRunRecord;
  sourceRevision: TranscriptRevisionRecord;
  sourceTranscript: TranscriptRecord;
}>;

export type PersistedTranscriptCleanupSuccess = Readonly<{
  cleanedTranscriptId: string;
  cleanedRevisionId: string;
  rawResponseId: string;
  rawResponseBlobKey: string;
  rawResponseMediaType: string;
  rawResponseByteSize: bigint;
  rawResponseSha256: string;
  rawResponseProviderRequestId?: string;
  rawResponseRetention: 'days_30';
  rawResponseExpiresAt: Date;
  text: string;
  provider: Readonly<Record<string, unknown>>;
  model: Readonly<Record<string, unknown>>;
  effectiveConfiguration: Readonly<Record<string, unknown>>;
  usage: Readonly<Record<string, unknown>>;
  processingTimeMilliseconds: bigint;
  now: Date;
}>;

export class TranscriptCleanupRepository {
  public constructor(private readonly database: JournalDatabase) {}

  public async load(runId: string): Promise<CanonicalTranscriptCleanupInput> {
    const row = await this.find(this.database, runId, false);
    if (row === undefined) {
      throw new QueueJobError(
        'permanent',
        'Transcript cleanup run does not exist.',
      );
    }
    return row;
  }

  public async markRunning(runId: string, now: Date): Promise<number> {
    return inTransaction(this.database, async (transaction) => {
      const canonical = await this.lock(transaction, runId);
      if (
        canonical.sourceTranscript.currentRevisionId !==
        canonical.sourceRevision.id
      ) {
        await this.cancelLocked(transaction, canonical.run, now);
        throw new QueueJobError(
          'canceled',
          'Transcript cleanup input is no longer current.',
        );
      }
      const executionCount = canonical.run.executionCount + 1;
      await transaction
        .update(transcriptCleanupRuns)
        .set({
          executionCount,
          status: 'running',
          errorCode: null,
          errorRetryable: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(transcriptCleanupRuns.id, runId));
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
        .update(transcriptCleanupRuns)
        .set({
          status: 'failed',
          errorCode: code,
          errorRetryable: retryable,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(transcriptCleanupRuns.id, runId));
    });
  }

  public async markCanceled(runId: string, now: Date): Promise<void> {
    await inTransaction(this.database, async (transaction) => {
      const canonical = await this.lock(transaction, runId);
      if (canonical.run.status === 'succeeded') return;
      await this.cancelLocked(transaction, canonical.run, now);
    });
  }

  public async complete(
    runId: string,
    result: PersistedTranscriptCleanupSuccess,
  ): Promise<void> {
    await inTransaction(this.database, async (transaction) => {
      const canonical = await this.lock(transaction, runId);
      if (canonical.run.status === 'succeeded') return;
      if (
        canonical.sourceTranscript.currentRevisionId !==
        canonical.sourceRevision.id
      ) {
        await this.cancelLocked(transaction, canonical.run, result.now);
        throw new QueueJobError(
          'canceled',
          'Transcript cleanup input is no longer current.',
        );
      }

      let [cleanedTranscript] = await transaction
        .select()
        .from(transcripts)
        .where(
          and(
            eq(transcripts.recordingId, canonical.sourceTranscript.recordingId),
            eq(transcripts.layer, 'cleaned'),
          ),
        )
        .limit(1)
        .for('update');
      if (cleanedTranscript === undefined) {
        [cleanedTranscript] = await transaction
          .insert(transcripts)
          .values({
            id: result.cleanedTranscriptId,
            recordingId: canonical.sourceTranscript.recordingId,
            layer: 'cleaned',
            createdAt: result.now,
            updatedAt: result.now,
          })
          .returning();
      }
      if (cleanedTranscript === undefined) {
        throw new TranscriptCleanupStateError(
          'Cleaned transcript was not created.',
        );
      }
      const revisionNumber = cleanedTranscript.currentRevision + 1;
      const evidenceText = canonicalTranscriptEvidenceText(result.text);
      await transaction.insert(transcriptRevisions).values({
        id: result.cleanedRevisionId,
        transcriptId: cleanedTranscript.id,
        sourceRevisionId: canonical.sourceRevision.id,
        revision: revisionNumber,
        text: result.text,
        evidenceText,
        segments: [],
        language: canonical.sourceRevision.language,
        timingAvailability: { segments: 'unknown', words: 'unknown' },
        authority: 'generated',
        contentHash: sha256(result.text),
        createdAt: result.now,
      });
      await transaction
        .update(transcripts)
        .set({
          currentRevisionId: result.cleanedRevisionId,
          currentRevision: revisionNumber,
          updatedAt: result.now,
        })
        .where(eq(transcripts.id, cleanedTranscript.id));
      await transaction
        .update(transcriptCleanupRuns)
        .set({
          status: 'succeeded',
          outputCleanedRevisionId: result.cleanedRevisionId,
          provider: result.provider,
          model: result.model,
          effectiveConfiguration: result.effectiveConfiguration,
          usage: result.usage,
          processingTimeMilliseconds: result.processingTimeMilliseconds,
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
        .where(eq(transcriptCleanupRuns.id, runId));
    });
  }

  private async find(
    context: RepositoryContext,
    runId: string,
    lock: boolean,
  ): Promise<CanonicalTranscriptCleanupInput | undefined> {
    const query = context
      .select({
        run: transcriptCleanupRuns,
        sourceRevision: transcriptRevisions,
        sourceTranscript: transcripts,
      })
      .from(transcriptCleanupRuns)
      .innerJoin(
        transcriptRevisions,
        eq(
          transcriptRevisions.id,
          transcriptCleanupRuns.sourceCorrectedRevisionId,
        ),
      )
      .innerJoin(
        transcripts,
        eq(transcripts.id, transcriptRevisions.transcriptId),
      )
      .where(eq(transcriptCleanupRuns.id, runId))
      .limit(1);
    const [row] = lock ? await query.for('update') : await query;
    return row;
  }

  private async lock(
    transaction: JournalTransaction,
    runId: string,
  ): Promise<CanonicalTranscriptCleanupInput> {
    const row = await this.find(transaction, runId, true);
    if (row === undefined) {
      throw new QueueJobError(
        'permanent',
        'Transcript cleanup run does not exist.',
      );
    }
    return row;
  }

  private async cancelLocked(
    transaction: RepositoryContext,
    run: TranscriptCleanupRunRecord,
    now: Date,
  ): Promise<void> {
    if (run.status === 'succeeded') return;
    await transaction
      .update(transcriptCleanupRuns)
      .set({ status: 'canceled', completedAt: now, updatedAt: now })
      .where(eq(transcriptCleanupRuns.id, run.id));
  }
}
