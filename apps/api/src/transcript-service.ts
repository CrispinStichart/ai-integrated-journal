import { createHash } from 'node:crypto';

import type {
  RecordingTranscriptInspector,
  TranscriptLayerResource,
  TranscriptProcessingRunResource,
  TranscriptRevisionResource,
} from '@journal/contracts';
import {
  appendCorrectedTranscriptRevision,
  auditEvents,
  contributions,
  enqueueTranscriptCleanup,
  inTransaction,
  journalDays,
  recordingApiIdempotency,
  recordings,
  transcriptCleanupRuns,
  transcriptRevisions,
  transcriptSegments,
  transcriptionRuns,
  transcripts,
  TranscriptCleanupStateError,
  TranscriptRevisionConflictError,
  type JournalDatabase,
  type RepositoryContext,
} from '@journal/database';
import { createUuidV7 } from '@journal/domain';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

export class TranscriptNotFoundError extends Error {
  public constructor() {
    super('Transcript or recording not found.');
    this.name = 'TranscriptNotFoundError';
  }
}

export class TranscriptConflictError extends Error {
  public constructor(message = 'The transcript has changed.') {
    super(message);
    this.name = 'TranscriptConflictError';
  }
}

export class TranscriptRetryUnavailableError extends Error {
  public constructor(message = 'This processing stage cannot be retried.') {
    super(message);
    this.name = 'TranscriptRetryUnavailableError';
  }
}

type TranscriptRow = typeof transcripts.$inferSelect;
type TranscriptRevisionRow = typeof transcriptRevisions.$inferSelect;
type TranscriptSegmentRow = typeof transcriptSegments.$inferSelect;
type TranscriptionRunRow = typeof transcriptionRuns.$inferSelect;
type CleanupRunRow = typeof transcriptCleanupRuns.$inferSelect;

export interface TranscriptService {
  inspect(
    ownerId: string,
    recordingId: string,
  ): Promise<RecordingTranscriptInspector>;
  history(
    ownerId: string,
    transcriptId: string,
  ): Promise<readonly TranscriptRevisionResource[]>;
  editCorrected(
    ownerId: string,
    transcriptId: string,
    expectedRevision: number,
    text: string,
    editReason: string | undefined,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<
    Readonly<{ inspector: RecordingTranscriptInspector; replayed: boolean }>
  >;
  retryCleanup(
    ownerId: string,
    transcriptId: string,
    expectedRevision: number,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<
    Readonly<{ inspector: RecordingTranscriptInspector; replayed: boolean }>
  >;
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function ownedRecording(
  context: RepositoryContext,
  ownerId: string,
  recordingId: string,
) {
  const [row] = await context
    .select({ recording: recordings })
    .from(recordings)
    .innerJoin(contributions, eq(contributions.id, recordings.contributionId))
    .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
    .where(and(eq(recordings.id, recordingId), eq(journalDays.userId, ownerId)))
    .limit(1);
  if (row === undefined) throw new TranscriptNotFoundError();
  return row.recording;
}

async function ownedTranscript(
  context: RepositoryContext,
  ownerId: string,
  transcriptId: string,
) {
  const [row] = await context
    .select({ transcript: transcripts, revision: transcriptRevisions })
    .from(transcripts)
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .innerJoin(contributions, eq(contributions.id, recordings.contributionId))
    .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
    .innerJoin(
      transcriptRevisions,
      eq(transcriptRevisions.id, transcripts.currentRevisionId),
    )
    .where(
      and(eq(transcripts.id, transcriptId), eq(journalDays.userId, ownerId)),
    )
    .limit(1);
  if (row === undefined) throw new TranscriptNotFoundError();
  return row;
}

function mapRevision(
  revision: TranscriptRevisionRow,
  segments: readonly TranscriptSegmentRow[],
): TranscriptRevisionResource {
  return {
    id: revision.id,
    transcriptId: revision.transcriptId,
    revision: revision.revision,
    text: revision.text,
    authority: revision.authority,
    ...(revision.authorId === null ? {} : { authorId: revision.authorId }),
    ...(revision.editReason === null
      ? {}
      : { editReason: revision.editReason }),
    ...(revision.sourceRunId === null
      ? {}
      : { sourceRunId: revision.sourceRunId }),
    ...(revision.sourceRevisionId === null
      ? {}
      : { sourceRevisionId: revision.sourceRevisionId }),
    language: revision.language,
    timingAvailability: revision.timingAvailability,
    segments: segments.map((segment) => ({
      id: segment.id,
      ...(segment.sourceSegmentId === null
        ? {}
        : { sourceSegmentId: segment.sourceSegmentId }),
      ordinal: segment.ordinal,
      startUtf16: segment.startUtf16,
      endUtf16: segment.endUtf16,
      quote: segment.quote,
      timing:
        segment.startMs === null || segment.endMs === null
          ? { status: 'unknown' as const }
          : {
              status: 'known' as const,
              startMilliseconds: segment.startMs.toString(),
              endMilliseconds: segment.endMs.toString(),
            },
    })),
    ...(revision.staleAt === null
      ? {}
      : {
          staleAt: revision.staleAt.toISOString(),
          staleReason: revision.staleReason ?? 'source_revision_superseded',
        }),
    createdAt: revision.createdAt.toISOString(),
  };
}

function mapTranscriptionRun(
  run: TranscriptionRunRow,
): TranscriptProcessingRunResource {
  return {
    id: run.id,
    stage: 'transcription',
    status: run.status,
    attempt: run.attempt,
    retryable: run.status === 'failed' && run.errorRetryable === true,
    ...(run.errorCode === null ? {} : { errorCode: run.errorCode }),
    ...(run.provider === null ? {} : { provider: run.provider }),
    ...(run.model === null ? {} : { model: run.model }),
    configuration: run.effectiveConfiguration ?? run.requestedConfiguration,
    context: [...(run.effectiveContext ?? run.requestedContext)],
    ...(run.processingTimeMilliseconds === null
      ? {}
      : {
          processingTimeMilliseconds: run.processingTimeMilliseconds.toString(),
        }),
    queuedAt: run.queuedAt.toISOString(),
    ...(run.startedAt === null
      ? {}
      : { startedAt: run.startedAt.toISOString() }),
    ...(run.completedAt === null
      ? {}
      : { completedAt: run.completedAt.toISOString() }),
  };
}

function mapCleanupRun(run: CleanupRunRow): TranscriptProcessingRunResource {
  return {
    id: run.id,
    stage: 'cleanup',
    status: run.staleAt === null ? run.status : 'stale',
    attempt: run.attempt,
    retryable:
      (run.status === 'failed' && run.errorRetryable === true) ||
      run.status === 'canceled',
    ...(run.errorCode === null ? {} : { errorCode: run.errorCode }),
    ...(run.provider === null ? {} : { provider: run.provider }),
    ...(run.model === null ? {} : { model: run.model }),
    configuration: run.effectiveConfiguration ?? run.requestedConfiguration,
    prompt: {
      id: run.promptId,
      version: run.promptVersion,
      templateHash: run.promptTemplateHash,
    },
    ...(run.processingTimeMilliseconds === null
      ? {}
      : {
          processingTimeMilliseconds: run.processingTimeMilliseconds.toString(),
        }),
    sourceRevisionId: run.sourceCorrectedRevisionId,
    queuedAt: run.queuedAt.toISOString(),
    ...(run.startedAt === null
      ? {}
      : { startedAt: run.startedAt.toISOString() }),
    ...(run.completedAt === null
      ? {}
      : { completedAt: run.completedAt.toISOString() }),
  };
}

async function readIdempotency(
  context: RepositoryContext,
  input: {
    ownerId: string;
    operation: string;
    idempotencyKey: string;
    hash: string;
    recordingId: string;
  },
): Promise<boolean> {
  const [existing] = await context
    .select()
    .from(recordingApiIdempotency)
    .where(
      and(
        eq(recordingApiIdempotency.ownerId, input.ownerId),
        eq(recordingApiIdempotency.operation, input.operation),
        eq(recordingApiIdempotency.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing === undefined) return false;
  if (
    existing.requestHash !== input.hash ||
    existing.recordingId !== input.recordingId
  ) {
    throw new TranscriptConflictError(
      'The idempotency key was reused with different transcript input.',
    );
  }
  return true;
}

async function writeIdempotency(
  context: RepositoryContext,
  input: {
    ownerId: string;
    operation: string;
    idempotencyKey: string;
    hash: string;
    recordingId: string;
  },
): Promise<void> {
  await context.insert(recordingApiIdempotency).values({
    ownerId: input.ownerId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.hash,
    recordingId: input.recordingId,
  });
}

export class PostgresTranscriptService implements TranscriptService {
  public constructor(
    private readonly database: JournalDatabase,
    private readonly boss: PgBoss,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async inspect(
    ownerId: string,
    recordingId: string,
  ): Promise<RecordingTranscriptInspector> {
    const recording = await ownedRecording(this.database, ownerId, recordingId);
    const layerRows = await this.database
      .select({ transcript: transcripts, revision: transcriptRevisions })
      .from(transcripts)
      .innerJoin(
        transcriptRevisions,
        eq(transcriptRevisions.id, transcripts.currentRevisionId),
      )
      .where(eq(transcripts.recordingId, recordingId));
    const revisionIds = layerRows.map(({ revision }) => revision.id);
    const segmentRows =
      revisionIds.length === 0
        ? []
        : await this.database
            .select()
            .from(transcriptSegments)
            .where(
              inArray(transcriptSegments.transcriptRevisionId, revisionIds),
            )
            .orderBy(transcriptSegments.ordinal);
    const segmentsByRevision = new Map<string, TranscriptSegmentRow[]>();
    for (const segment of segmentRows) {
      const current =
        segmentsByRevision.get(segment.transcriptRevisionId) ?? [];
      current.push(segment);
      segmentsByRevision.set(segment.transcriptRevisionId, current);
    }
    const layers = new Map(
      layerRows.map(({ transcript, revision }) => [
        transcript.layer,
        this.mapLayer(
          transcript,
          revision,
          segmentsByRevision.get(revision.id) ?? [],
        ),
      ]),
    );
    const [transcription] = await this.database
      .select()
      .from(transcriptionRuns)
      .where(eq(transcriptionRuns.recordingId, recordingId))
      .orderBy(desc(transcriptionRuns.attempt))
      .limit(1);
    const [cleanup] = await this.database
      .select()
      .from(transcriptCleanupRuns)
      .where(eq(transcriptCleanupRuns.recordingId, recordingId))
      .orderBy(
        desc(transcriptCleanupRuns.queuedAt),
        desc(transcriptCleanupRuns.id),
      )
      .limit(1);
    const audioAvailable =
      recording.persistenceState === 'durable' &&
      recording.audioDeletedAt === null;
    return {
      recordingId,
      audioAvailable,
      ...(audioAvailable
        ? {}
        : {
            audioUnavailableReason:
              recording.audioDeletedAt !== null
                ? ('deleted' as const)
                : ('not_durable' as const),
          }),
      ...(transcription === undefined
        ? {}
        : { transcription: mapTranscriptionRun(transcription) }),
      ...(cleanup === undefined ? {} : { cleanup: mapCleanupRun(cleanup) }),
      ...(layers.get('raw_stt') === undefined
        ? {}
        : { rawStt: layers.get('raw_stt') }),
      ...(layers.get('corrected') === undefined
        ? {}
        : { corrected: layers.get('corrected') }),
      ...(layers.get('cleaned') === undefined
        ? {}
        : { cleaned: layers.get('cleaned') }),
    };
  }

  public async history(
    ownerId: string,
    transcriptId: string,
  ): Promise<readonly TranscriptRevisionResource[]> {
    await ownedTranscript(this.database, ownerId, transcriptId);
    const revisions = await this.database
      .select()
      .from(transcriptRevisions)
      .where(eq(transcriptRevisions.transcriptId, transcriptId))
      .orderBy(desc(transcriptRevisions.revision));
    const revisionIds = revisions.map(({ id }) => id);
    const segments =
      revisionIds.length === 0
        ? []
        : await this.database
            .select()
            .from(transcriptSegments)
            .where(
              inArray(transcriptSegments.transcriptRevisionId, revisionIds),
            )
            .orderBy(transcriptSegments.ordinal);
    return revisions.map((revision) =>
      mapRevision(
        revision,
        segments.filter(
          (segment) => segment.transcriptRevisionId === revision.id,
        ),
      ),
    );
  }

  public async editCorrected(
    ownerId: string,
    transcriptId: string,
    expectedRevision: number,
    text: string,
    editReason: string | undefined,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const owned = await ownedTranscript(this.database, ownerId, transcriptId);
    if (owned.transcript.layer !== 'corrected')
      throw new TranscriptNotFoundError();
    const operation = `transcript.corrected.edit.${transcriptId}`;
    const hash = requestHash({ expectedRevision, text, editReason });
    const ledger = {
      ownerId,
      operation,
      idempotencyKey,
      hash,
      recordingId: owned.transcript.recordingId,
    };
    if (await readIdempotency(this.database, ledger)) {
      return {
        inspector: await this.inspect(ownerId, owned.transcript.recordingId),
        replayed: true,
      };
    }
    if (owned.revision.revision !== expectedRevision)
      throw new TranscriptConflictError();
    const [priorCleanup] = await this.database
      .select()
      .from(transcriptCleanupRuns)
      .where(
        eq(transcriptCleanupRuns.sourceCorrectedRevisionId, owned.revision.id),
      )
      .orderBy(desc(transcriptCleanupRuns.attempt))
      .limit(1);
    if (priorCleanup === undefined) {
      throw new TranscriptRetryUnavailableError(
        'Cleanup configuration is unavailable for this transcript.',
      );
    }
    try {
      await appendCorrectedTranscriptRevision({
        boss: this.boss,
        database: this.database,
        transcriptId,
        expectedRevisionId: owned.revision.id,
        authorId: ownerId,
        text,
        ...(editReason === undefined ? {} : { editReason }),
        prompt: {
          id: priorCleanup.promptId,
          version: priorCleanup.promptVersion,
          templateHash: priorCleanup.promptTemplateHash,
        },
        cleanupConfiguration: priorCleanup.requestedConfiguration,
        now: this.now(),
        afterAppend: async (transaction, result) => {
          await writeIdempotency(transaction, ledger);
          await transaction.insert(auditEvents).values({
            id: createUuidV7<'audit-event'>(),
            action: 'transcript.corrected.revised',
            actorId: ownerId,
            entityType: 'transcript',
            entityId: transcriptId,
            revisionId: result.revision.id,
            correlationId,
            metadata: { authority: 'manual', globalRuleCreated: false },
            occurredAt: this.now(),
          });
        },
      });
    } catch (error) {
      if (
        error instanceof TranscriptRevisionConflictError &&
        (await readIdempotency(this.database, ledger))
      ) {
        return {
          inspector: await this.inspect(ownerId, owned.transcript.recordingId),
          replayed: true,
        };
      }
      if (error instanceof TranscriptRevisionConflictError)
        throw new TranscriptConflictError();
      throw error;
    }
    return {
      inspector: await this.inspect(ownerId, owned.transcript.recordingId),
      replayed: false,
    };
  }

  public async retryCleanup(
    ownerId: string,
    transcriptId: string,
    expectedRevision: number,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const owned = await ownedTranscript(this.database, ownerId, transcriptId);
    if (owned.transcript.layer !== 'corrected')
      throw new TranscriptNotFoundError();
    const operation = `transcript.cleanup.retry.${transcriptId}`;
    const hash = requestHash({ expectedRevision });
    const ledger = {
      ownerId,
      operation,
      idempotencyKey,
      hash,
      recordingId: owned.transcript.recordingId,
    };
    if (await readIdempotency(this.database, ledger)) {
      return {
        inspector: await this.inspect(ownerId, owned.transcript.recordingId),
        replayed: true,
      };
    }
    if (owned.revision.revision !== expectedRevision)
      throw new TranscriptConflictError();
    try {
      await inTransaction(this.database, async (transaction) => {
        const [latest] = await transaction
          .select()
          .from(transcriptCleanupRuns)
          .where(
            eq(
              transcriptCleanupRuns.sourceCorrectedRevisionId,
              owned.revision.id,
            ),
          )
          .orderBy(desc(transcriptCleanupRuns.attempt))
          .limit(1);
        if (
          latest === undefined ||
          !['failed', 'canceled'].includes(latest.status) ||
          (latest.status === 'failed' && latest.errorRetryable !== true)
        ) {
          throw new TranscriptRetryUnavailableError();
        }
        const run = await enqueueTranscriptCleanup({
          boss: this.boss,
          transaction,
          sourceCorrectedRevisionId: owned.revision.id,
          prompt: {
            id: latest.promptId,
            version: latest.promptVersion,
            templateHash: latest.promptTemplateHash,
          },
          requestedConfiguration: latest.requestedConfiguration,
          retryTerminal: true,
          now: this.now(),
        });
        await writeIdempotency(transaction, ledger);
        await transaction.insert(auditEvents).values({
          id: createUuidV7<'audit-event'>(),
          action: 'transcript.cleanup.retried',
          actorId: ownerId,
          entityType: 'transcript',
          entityId: transcriptId,
          revisionId: owned.revision.id,
          correlationId,
          metadata: { runId: run.id, attempt: run.attempt },
          occurredAt: this.now(),
        });
      });
    } catch (error) {
      if (
        error instanceof TranscriptCleanupStateError &&
        (await readIdempotency(this.database, ledger))
      ) {
        return {
          inspector: await this.inspect(ownerId, owned.transcript.recordingId),
          replayed: true,
        };
      }
      throw error;
    }
    return {
      inspector: await this.inspect(ownerId, owned.transcript.recordingId),
      replayed: false,
    };
  }

  private mapLayer(
    transcript: TranscriptRow,
    revision: TranscriptRevisionRow,
    segments: readonly TranscriptSegmentRow[],
  ): TranscriptLayerResource {
    return {
      id: transcript.id,
      recordingId: transcript.recordingId,
      layer: transcript.layer,
      revisionCount: transcript.currentRevision,
      currentRevision: mapRevision(revision, segments),
      createdAt: transcript.createdAt.toISOString(),
      updatedAt: transcript.updatedAt.toISOString(),
    };
  }
}
