import { createHash } from 'node:crypto';

import {
  MAX_AUDIO_CHUNK_BYTES,
  type CreateRecordingRequest,
  type FinalizeRecordingRequest,
  type RecordingResource,
} from '@journal/contracts';
import {
  auditEvents,
  contributions,
  inTransaction,
  enqueueTranscriptionRun,
  journalDays,
  recordingApiIdempotency,
  recordingChunks,
  recordings,
  recordingUploads,
  TranscriptionStateError,
  type JournalDatabase,
  type RepositoryContext,
} from '@journal/database';
import { createUuidV7 } from '@journal/domain';
import {
  BlobConflictError,
  BlobNotFoundError,
  type BlobStore,
  type ByteRange,
  type StagedChunk,
} from '@journal/storage';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

const MANIFEST_PAGE_SIZE = 512;
export const AUDIO_DELETION_WARNING =
  'Audio verification and timestamp playback are unavailable while audio is deleted.' as const;

export class RecordingConflictError extends Error {
  public constructor(
    message = 'Recording upload conflicts with durable state.',
  ) {
    super(message);
    this.name = 'RecordingConflictError';
  }
}
export class RecordingNotFoundError extends Error {
  public constructor() {
    super('Recording not found.');
    this.name = 'RecordingNotFoundError';
  }
}
export class RecordingAudioDeletedError extends Error {
  public constructor() {
    super('Recording audio is deleted.');
    this.name = 'RecordingAudioDeletedError';
  }
}
export class RecordingNotDurableError extends Error {
  public constructor() {
    super('Recording audio is not durably available.');
    this.name = 'RecordingNotDurableError';
  }
}

export type RecordingMutationResult = Readonly<{
  recording: RecordingResource;
  replayed: boolean;
}>;
export interface RecordingService {
  create(
    ownerId: string,
    input: CreateRecordingRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<RecordingMutationResult>;
  uploadChunk(
    ownerId: string,
    recordingId: string,
    index: number,
    checksum: string,
    idempotencyKey: string,
    input: AsyncIterable<Uint8Array>,
  ): Promise<
    Readonly<{
      index: number;
      byteSize: string;
      sha256: string;
      replayed: boolean;
    }>
  >;
  getUpload(
    ownerId: string,
    recordingId: string,
    after: number | undefined,
    limit: number,
  ): Promise<
    Readonly<{
      recording: RecordingResource;
      acceptedIndexes: readonly number[];
      nextAfter?: number;
    }>
  >;
  finalize(
    ownerId: string,
    recordingId: string,
    input: FinalizeRecordingRequest,
    idempotencyKey: string,
  ): Promise<RecordingMutationResult>;
  retry(
    ownerId: string,
    recordingId: string,
    idempotencyKey: string,
  ): Promise<RecordingMutationResult>;
  retryTranscription(
    ownerId: string,
    recordingId: string,
    idempotencyKey: string,
  ): Promise<RecordingMutationResult>;
  openAudio(
    ownerId: string,
    recordingId: string,
    range: ByteRange,
  ): Promise<
    Readonly<{
      recording: RecordingResource;
      stream: ReadableStream<Uint8Array>;
    }>
  >;
  deleteAudio(
    ownerId: string,
    recordingId: string,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<
    RecordingMutationResult & { warning: typeof AUDIO_DELETION_WARNING }
  >;
  restoreAudio(
    ownerId: string,
    recordingId: string,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<RecordingMutationResult>;
}

type RecordingRow = typeof recordings.$inferSelect;
type UploadRow = typeof recordingUploads.$inferSelect;

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function mapRecording(row: RecordingRow, uploadId: string): RecordingResource {
  return {
    id: row.id,
    contributionId: row.contributionId,
    uploadId,
    mimeType: row.mimeType,
    ...(row.codec === null ? {} : { codec: row.codec }),
    persistenceState: row.persistenceState,
    transcription: {
      state: row.transcriptionState,
      ...(row.latestTranscriptionRunId === null
        ? {}
        : { runId: row.latestTranscriptionRunId }),
    },
    ...(row.durationMilliseconds === null
      ? {}
      : { durationMilliseconds: row.durationMilliseconds.toString() }),
    ...(row.finalByteSize === null
      ? {}
      : { byteSize: row.finalByteSize.toString() }),
    ...(row.finalSha256 === null ? {} : { sha256: row.finalSha256 }),
    ...(row.audioDeletedAt === null
      ? {}
      : { audioDeletedAt: row.audioDeletedAt.toISOString() }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function ownedRecording(
  context: RepositoryContext,
  ownerId: string,
  recordingId: string,
  lock = false,
): Promise<{ recording: RecordingRow; upload: UploadRow }> {
  const base = context
    .select({ recording: recordings, upload: recordingUploads })
    .from(recordings)
    .innerJoin(contributions, eq(contributions.id, recordings.contributionId))
    .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
    .innerJoin(
      recordingUploads,
      eq(recordingUploads.recordingId, recordings.id),
    )
    .where(and(eq(recordings.id, recordingId), eq(journalDays.userId, ownerId)))
    .limit(1);
  const rows = lock ? await base.for('update') : await base;
  const result = rows[0];
  if (result === undefined) throw new RecordingNotFoundError();
  return result;
}

async function recordIdempotency(
  context: RepositoryContext,
  input: {
    ownerId: string;
    operation: string;
    key: string;
    requestHash: string;
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
        eq(recordingApiIdempotency.idempotencyKey, input.key),
      ),
    )
    .limit(1);
  if (existing !== undefined) {
    if (
      existing.requestHash !== input.requestHash ||
      existing.recordingId !== input.recordingId
    ) {
      throw new RecordingConflictError(
        'Idempotency key was reused with different input.',
      );
    }
    return true;
  }
  await context.insert(recordingApiIdempotency).values({
    ownerId: input.ownerId,
    operation: input.operation,
    idempotencyKey: input.key,
    requestHash: input.requestHash,
    recordingId: input.recordingId,
  });
  return false;
}

export class PostgresRecordingService implements RecordingService {
  public constructor(
    private readonly database: JournalDatabase,
    private readonly blobStore: BlobStore,
    private readonly boss: PgBoss,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async create(
    ownerId: string,
    input: CreateRecordingRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<RecordingMutationResult> {
    return inTransaction(this.database, async (transaction) => {
      const requestHash = hashJson(input);
      const [exists] = await transaction
        .select({ id: recordings.id })
        .from(recordings)
        .where(eq(recordings.id, input.recordingId))
        .limit(1);
      if (exists !== undefined) {
        const owned = await ownedRecording(
          transaction,
          ownerId,
          input.recordingId,
        );
        const [source] = await transaction
          .select({
            capturedAt: contributions.capturedAt,
            capturedTimezone: contributions.capturedTimezone,
            journalTimezone: contributions.journalTimezone,
            journalDateAssignment: contributions.journalDateAssignment,
            journalDate: journalDays.journalDate,
          })
          .from(contributions)
          .innerJoin(
            journalDays,
            eq(journalDays.id, contributions.journalDayId),
          )
          .where(eq(contributions.id, input.contributionId))
          .limit(1);
        if (
          source === undefined ||
          owned.recording.contributionId !== input.contributionId ||
          owned.upload.id !== input.uploadId ||
          owned.recording.mimeType !== input.mimeType ||
          owned.recording.codec !== (input.codec ?? null) ||
          source.capturedAt.getTime() !==
            new Date(input.capturedAt).getTime() ||
          source.capturedTimezone !== input.capturedTimezone ||
          source.journalTimezone !== input.journalTimezone ||
          source.journalDateAssignment !== input.journalDateAssignment ||
          source.journalDate !== input.journalDate
        )
          throw new RecordingConflictError();
        await recordIdempotency(transaction, {
          ownerId,
          operation: 'recording.create',
          key: idempotencyKey,
          requestHash,
          recordingId: input.recordingId,
        });
        return {
          recording: mapRecording(owned.recording, owned.upload.id),
          replayed: true,
        };
      }
      await transaction
        .insert(journalDays)
        .values({
          id: input.proposedJournalDayId,
          userId: ownerId,
          journalDate: input.journalDate,
        })
        .onConflictDoNothing({
          target: [journalDays.userId, journalDays.journalDate],
        });
      const [day] = await transaction
        .select({ id: journalDays.id })
        .from(journalDays)
        .where(
          and(
            eq(journalDays.userId, ownerId),
            eq(journalDays.journalDate, input.journalDate),
          ),
        )
        .limit(1);
      if (day === undefined) throw new RecordingConflictError();
      await transaction.insert(contributions).values({
        id: input.contributionId,
        journalDayId: day.id,
        authorId: ownerId,
        sourceType: 'recording',
        capturedAt: new Date(input.capturedAt),
        capturedTimezone: input.capturedTimezone,
        journalTimezone: input.journalTimezone,
        journalDateAssignment: input.journalDateAssignment,
      });
      const [row] = await transaction
        .insert(recordings)
        .values({
          id: input.recordingId,
          contributionId: input.contributionId,
          mimeType: input.mimeType,
          ...(input.codec === undefined ? {} : { codec: input.codec }),
        })
        .returning();
      if (row === undefined) throw new RecordingConflictError();
      await transaction
        .insert(recordingUploads)
        .values({ id: input.uploadId, recordingId: input.recordingId });
      await recordIdempotency(transaction, {
        ownerId,
        operation: 'recording.create',
        key: idempotencyKey,
        requestHash,
        recordingId: input.recordingId,
      });
      await transaction.insert(auditEvents).values({
        id: createUuidV7<'audit-event'>(),
        action: 'recording.created',
        actorId: ownerId,
        entityType: 'recording',
        entityId: input.recordingId,
        correlationId,
        metadata: { sourceType: 'recording' },
        occurredAt: this.now(),
      });
      return { recording: mapRecording(row, input.uploadId), replayed: false };
    });
  }

  public async uploadChunk(
    ownerId: string,
    recordingId: string,
    index: number,
    checksum: string,
    idempotencyKey: string,
    input: AsyncIterable<Uint8Array>,
  ) {
    const identity = await ownedRecording(this.database, ownerId, recordingId);
    let bytes = 0;
    const bounded = (async function* () {
      for await (const part of input) {
        bytes += part.byteLength;
        if (bytes > MAX_AUDIO_CHUNK_BYTES)
          throw new RangeError('Audio chunk exceeds 8 MiB.');
        yield part;
      }
    })();
    let staged: StagedChunk;
    try {
      staged = await this.blobStore.putStagingChunk(
        identity.upload.id,
        index,
        bounded,
        checksum,
      );
    } catch (error) {
      if (error instanceof BlobConflictError)
        throw new RecordingConflictError(error.message);
      throw error;
    }
    return inTransaction(this.database, async (transaction) => {
      const current = await ownedRecording(
        transaction,
        ownerId,
        recordingId,
        true,
      );
      const idempotentReplay = await recordIdempotency(transaction, {
        ownerId,
        operation: `recording.chunk.${String(index)}`,
        key: idempotencyKey,
        requestHash: hashJson({
          index,
          checksum,
          byteSize: staged.byteSize.toString(),
        }),
        recordingId,
      });
      const [existing] = await transaction
        .select()
        .from(recordingChunks)
        .where(
          and(
            eq(recordingChunks.uploadId, current.upload.id),
            eq(recordingChunks.chunkIndex, index),
          ),
        )
        .limit(1);
      if (existing !== undefined) {
        if (
          existing.byteSize !== staged.byteSize ||
          existing.sha256 !== staged.sha256 ||
          existing.stagingBlobKey !== staged.stagingKey
        )
          throw new RecordingConflictError();
        return {
          index,
          byteSize: staged.byteSize.toString(),
          sha256: staged.sha256,
          replayed: true,
        };
      }
      if (current.recording.persistenceState !== 'uploading')
        throw new RecordingConflictError(
          'New chunks are forbidden after manifest preparation.',
        );
      await transaction.insert(recordingChunks).values({
        uploadId: current.upload.id,
        chunkIndex: index,
        byteSize: staged.byteSize,
        sha256: staged.sha256,
        stagingBlobKey: staged.stagingKey,
      });
      await transaction
        .update(recordingUploads)
        .set({ lastActivityAt: this.now() })
        .where(eq(recordingUploads.id, current.upload.id));
      return {
        index,
        byteSize: staged.byteSize.toString(),
        sha256: staged.sha256,
        replayed: idempotentReplay,
      };
    });
  }

  public async getUpload(
    ownerId: string,
    recordingId: string,
    after: number | undefined,
    limit: number,
  ) {
    const identity = await ownedRecording(this.database, ownerId, recordingId);
    const rows = await this.database
      .select({ index: recordingChunks.chunkIndex })
      .from(recordingChunks)
      .where(
        and(
          eq(recordingChunks.uploadId, identity.upload.id),
          after === undefined
            ? undefined
            : gt(recordingChunks.chunkIndex, after),
        ),
      )
      .orderBy(asc(recordingChunks.chunkIndex))
      .limit(limit + 1);
    const nextAfter = rows.length > limit ? rows[limit - 1]?.index : undefined;
    return {
      recording: mapRecording(identity.recording, identity.upload.id),
      acceptedIndexes: rows.slice(0, limit).map((row) => row.index),
      ...(nextAfter === undefined ? {} : { nextAfter }),
    };
  }

  private async *chunks(uploadId: string): AsyncGenerator<StagedChunk> {
    let after = -1;
    while (true) {
      const page = await this.database
        .select()
        .from(recordingChunks)
        .where(
          and(
            eq(recordingChunks.uploadId, uploadId),
            gt(recordingChunks.chunkIndex, after),
          ),
        )
        .orderBy(asc(recordingChunks.chunkIndex))
        .limit(MANIFEST_PAGE_SIZE);
      for (const row of page) {
        yield {
          uploadId,
          index: row.chunkIndex,
          byteSize: row.byteSize,
          sha256: row.sha256,
          stagingKey: row.stagingBlobKey,
        };
        after = row.chunkIndex;
      }
      if (page.length < MANIFEST_PAGE_SIZE) return;
    }
  }

  private async validateManifest(
    uploadId: string,
    input: FinalizeRecordingRequest,
  ): Promise<void> {
    const digest = createHash('sha256');
    let count = 0n;
    let total = 0n;
    for await (const chunk of this.chunks(uploadId)) {
      if (chunk.index !== Number(count))
        throw new RecordingConflictError('Chunk manifest contains a gap.');
      digest.update(
        `${String(chunk.index)}:${chunk.byteSize.toString()}:${chunk.sha256}\n`,
      );
      count += 1n;
      total += chunk.byteSize;
    }
    if (
      count !== BigInt(input.chunkCount) ||
      total !== BigInt(input.totalBytes) ||
      digest.digest('hex') !== input.manifestSha256
    ) {
      throw new RecordingConflictError(
        'Manifest summary does not match accepted chunks.',
      );
    }
  }

  private async publish(
    ownerId: string,
    recordingId: string,
    input: FinalizeRecordingRequest,
  ): Promise<RecordingResource> {
    const prepared = await ownedRecording(this.database, ownerId, recordingId);
    if (prepared.recording.persistenceState === 'durable') {
      return inTransaction(this.database, async (transaction) => {
        const current = await ownedRecording(
          transaction,
          ownerId,
          recordingId,
          true,
        );
        if (current.recording.latestTranscriptionRunId === null) {
          await enqueueTranscriptionRun({
            boss: this.boss,
            transaction,
            recordingId,
            now: this.now(),
          });
        }
        const [scheduled] = await transaction
          .select()
          .from(recordings)
          .where(eq(recordings.id, recordingId))
          .limit(1);
        if (scheduled === undefined) throw new RecordingNotFoundError();
        return mapRecording(scheduled, current.upload.id);
      });
    }
    if (
      prepared.recording.persistenceState !== 'prepared' ||
      prepared.recording.finalBlobKey === null ||
      prepared.recording.finalByteSize === null ||
      prepared.recording.finalSha256 === null
    )
      throw new RecordingConflictError(
        'Recording manifest has not been prepared.',
      );
    let blob;
    try {
      blob = await this.blobStore.finalizeChunks(
        prepared.upload.id,
        this.chunks(prepared.upload.id),
        {
          key: prepared.recording.finalBlobKey,
          expectedIntegrity: {
            byteSize: prepared.recording.finalByteSize,
            sha256: prepared.recording.finalSha256,
          },
        },
      );
    } catch (error) {
      if (error instanceof BlobConflictError)
        throw new RecordingConflictError(error.message);
      throw error;
    }
    return inTransaction(this.database, async (transaction) => {
      const current = await ownedRecording(
        transaction,
        ownerId,
        recordingId,
        true,
      );
      if (
        current.upload.manifestFingerprint !== hashJson(input) ||
        current.recording.finalBlobKey !== blob.key ||
        current.recording.finalByteSize !== blob.byteSize ||
        current.recording.finalSha256 !== blob.sha256
      )
        throw new RecordingConflictError(
          'Published blob conflicts with prepared state.',
        );
      const [updated] = await transaction
        .update(recordings)
        .set({ persistenceState: 'durable', updatedAt: this.now() })
        .where(eq(recordings.id, recordingId))
        .returning();
      if (updated === undefined) throw new RecordingNotFoundError();
      await enqueueTranscriptionRun({
        boss: this.boss,
        transaction,
        recordingId,
        now: this.now(),
      });
      const [scheduled] = await transaction
        .select()
        .from(recordings)
        .where(eq(recordings.id, recordingId))
        .limit(1);
      if (scheduled === undefined) throw new RecordingNotFoundError();
      return mapRecording(scheduled, current.upload.id);
    });
  }

  public async finalize(
    ownerId: string,
    recordingId: string,
    input: FinalizeRecordingRequest,
    idempotencyKey: string,
  ): Promise<RecordingMutationResult> {
    const requestHash = hashJson(input);
    const replayed = await inTransaction(this.database, async (transaction) => {
      const current = await ownedRecording(
        transaction,
        ownerId,
        recordingId,
        true,
      );
      const seen = await recordIdempotency(transaction, {
        ownerId,
        operation: 'recording.finalize',
        key: idempotencyKey,
        requestHash,
        recordingId,
      });
      if (current.recording.persistenceState !== 'uploading') {
        if (current.upload.manifestFingerprint !== requestHash)
          throw new RecordingConflictError(
            'A different manifest is already prepared.',
          );
        return true;
      }
      await this.validateManifest(current.upload.id, input);
      const finalBlobKey = `audio/${recordingId.slice(0, 2)}/${recordingId.slice(2, 4)}/${recordingId}/original.audio`;
      await transaction
        .update(recordingUploads)
        .set({
          manifestVersion: input.manifestVersion,
          manifestChunkCount: BigInt(input.chunkCount),
          manifestTotalBytes: BigInt(input.totalBytes),
          manifestSha256: input.manifestSha256,
          manifestFingerprint: requestHash,
          lastActivityAt: this.now(),
        })
        .where(eq(recordingUploads.id, current.upload.id));
      await transaction
        .update(recordings)
        .set({
          persistenceState: 'prepared',
          finalByteSize: BigInt(input.totalBytes),
          finalSha256: input.finalSha256,
          finalBlobKey,
          ...(input.durationMilliseconds === undefined
            ? {}
            : { durationMilliseconds: BigInt(input.durationMilliseconds) }),
          updatedAt: this.now(),
        })
        .where(eq(recordings.id, recordingId));
      return seen;
    });
    return {
      recording: await this.publish(ownerId, recordingId, input),
      replayed,
    };
  }

  public async retry(
    ownerId: string,
    recordingId: string,
    idempotencyKey: string,
  ): Promise<RecordingMutationResult> {
    const current = await ownedRecording(this.database, ownerId, recordingId);
    if (
      current.upload.manifestVersion !== 1 ||
      current.upload.manifestChunkCount === null ||
      current.upload.manifestTotalBytes === null ||
      current.upload.manifestSha256 === null ||
      current.recording.finalSha256 === null
    )
      throw new RecordingConflictError(
        'Only a prepared recording can be retried.',
      );
    const input: FinalizeRecordingRequest = {
      manifestVersion: 1,
      chunkCount: current.upload.manifestChunkCount.toString(),
      totalBytes: current.upload.manifestTotalBytes.toString(),
      manifestSha256: current.upload.manifestSha256,
      finalSha256: current.recording.finalSha256,
      ...(current.recording.durationMilliseconds === null
        ? {}
        : {
            durationMilliseconds:
              current.recording.durationMilliseconds.toString(),
          }),
    };
    const replayed = await inTransaction(this.database, (transaction) =>
      recordIdempotency(transaction, {
        ownerId,
        operation: 'recording.retry',
        key: idempotencyKey,
        requestHash: hashJson(input),
        recordingId,
      }),
    );
    return {
      recording: await this.publish(ownerId, recordingId, input),
      replayed,
    };
  }

  public async retryTranscription(
    ownerId: string,
    recordingId: string,
    idempotencyKey: string,
  ): Promise<RecordingMutationResult> {
    return inTransaction(this.database, async (transaction) => {
      const current = await ownedRecording(
        transaction,
        ownerId,
        recordingId,
        true,
      );
      const replayed = await recordIdempotency(transaction, {
        ownerId,
        operation: 'recording.transcription.retry',
        key: idempotencyKey,
        requestHash: hashJson({ recordingId }),
        recordingId,
      });
      if (!replayed) {
        try {
          await enqueueTranscriptionRun({
            boss: this.boss,
            transaction,
            recordingId,
            retryTerminal: true,
            now: this.now(),
          });
        } catch (error) {
          if (error instanceof TranscriptionStateError) {
            throw new RecordingConflictError(error.message);
          }
          throw error;
        }
      }
      const [updated] = await transaction
        .select()
        .from(recordings)
        .where(eq(recordings.id, recordingId))
        .limit(1);
      if (updated === undefined) throw new RecordingNotFoundError();
      return {
        recording: mapRecording(updated, current.upload.id),
        replayed,
      };
    });
  }

  public async openAudio(
    ownerId: string,
    recordingId: string,
    range: ByteRange,
  ) {
    const current = await ownedRecording(this.database, ownerId, recordingId);
    if (current.recording.audioDeletedAt !== null)
      throw new RecordingAudioDeletedError();
    if (
      current.recording.persistenceState !== 'durable' ||
      current.recording.finalBlobKey === null
    )
      throw new RecordingNotDurableError();
    try {
      return {
        recording: mapRecording(current.recording, current.upload.id),
        stream: await this.blobStore.open(
          current.recording.finalBlobKey,
          range,
        ),
      };
    } catch (error) {
      if (error instanceof BlobNotFoundError)
        throw new RecordingNotDurableError();
      throw error;
    }
  }

  private async setAudioDeleted(
    ownerId: string,
    recordingId: string,
    deleted: boolean,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<RecordingMutationResult> {
    return inTransaction(this.database, async (transaction) => {
      const current = await ownedRecording(
        transaction,
        ownerId,
        recordingId,
        true,
      );
      if (current.recording.persistenceState !== 'durable')
        throw new RecordingNotDurableError();
      const replayed = await recordIdempotency(transaction, {
        ownerId,
        operation: deleted
          ? 'recording.audio.delete'
          : 'recording.audio.restore',
        key: idempotencyKey,
        requestHash: hashJson({ deleted }),
        recordingId,
      });
      const already = deleted
        ? current.recording.audioDeletedAt !== null
        : current.recording.audioDeletedAt === null;
      if (already)
        return {
          recording: mapRecording(current.recording, current.upload.id),
          replayed: true,
        };
      const instant = this.now();
      const [updated] = await transaction
        .update(recordings)
        .set(
          deleted
            ? {
                audioDeletedAt: instant,
                audioDeletedBy: ownerId,
                audioRestoredAt: null,
                updatedAt: instant,
              }
            : {
                audioDeletedAt: null,
                audioDeletedBy: null,
                audioRestoredAt: instant,
                updatedAt: instant,
              },
        )
        .where(eq(recordings.id, recordingId))
        .returning();
      if (updated === undefined) throw new RecordingNotFoundError();
      await transaction.insert(auditEvents).values({
        id: createUuidV7<'audit-event'>(),
        action: deleted
          ? 'recording.audio.deleted'
          : 'recording.audio.restored',
        actorId: ownerId,
        entityType: 'recording',
        entityId: recordingId,
        correlationId,
        metadata: { recoverable: true },
        occurredAt: instant,
      });
      return { recording: mapRecording(updated, current.upload.id), replayed };
    });
  }

  public async deleteAudio(
    ownerId: string,
    recordingId: string,
    idempotencyKey: string,
    correlationId: string,
  ) {
    return {
      ...(await this.setAudioDeleted(
        ownerId,
        recordingId,
        true,
        idempotencyKey,
        correlationId,
      )),
      warning: AUDIO_DELETION_WARNING,
    };
  }
  public restoreAudio(
    ownerId: string,
    recordingId: string,
    idempotencyKey: string,
    correlationId: string,
  ) {
    return this.setAudioDeleted(
      ownerId,
      recordingId,
      false,
      idempotencyKey,
      correlationId,
    );
  }
}
