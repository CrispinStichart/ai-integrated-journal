import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  CreateRecordingRequest,
  FinalizeRecordingRequest,
} from '@journal/contracts';
import {
  createDatabaseClient,
  exportBlobLeases,
  exportRequests,
  migrateDatabase,
  recordingChunks,
  users,
  type DatabaseClient,
} from '@journal/database';
import { createUuidV7 } from '@journal/domain';
import { LocalBlobStore } from '@journal/storage';
import { createPostgresTestContainer } from '@journal/test-support';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresJournalService } from '../src/journal-service.js';
import {
  PostgresRecordingService,
  RecordingAudioDeletedError,
  RecordingConflictError,
} from '../src/recording-service.js';

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}
async function* bytes(value: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(value);
}
async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  let value = '';
  const decoder = new TextDecoder();
  for await (const chunk of stream)
    value += decoder.decode(chunk, { stream: true });
  return value + decoder.decode();
}

describe('recording persistence and recoverable finalization', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let blobRoot: string;
  let service: PostgresRecordingService;

  const ownerId = createUuidV7<'user'>({ timestamp: 100_000 });
  const recordingId = createUuidV7<'recording'>({ timestamp: 101_000 });
  const contributionId = createUuidV7<'contribution'>({ timestamp: 102_000 });
  const uploadId = createUuidV7<'recording-upload'>({ timestamp: 103_000 });
  const dayId = createUuidV7<'journal-day'>({ timestamp: 104_000 });
  const correlationId = createUuidV7<'correlation'>({ timestamp: 105_000 });
  const priorDayId = createUuidV7<'journal-day'>({ timestamp: 106_000 });
  const exportId = createUuidV7<'export'>({ timestamp: 107_000 });
  const now = new Date('2026-08-22T12:00:00.000Z');
  const createInput: CreateRecordingRequest = {
    recordingId,
    contributionId,
    uploadId,
    proposedJournalDayId: dayId,
    mimeType: 'audio/webm;codecs=opus',
    codec: 'opus',
    capturedAt: '2026-08-22T11:59:00.000Z',
    capturedTimezone: 'America/New_York',
    journalTimezone: 'America/New_York',
    journalDate: '2026-08-22',
    journalDateAssignment: 'default',
  };

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 6 },
    });
    await migrateDatabase(client.database);
    await client.database
      .insert(users)
      .values({ id: ownerId, displayName: 'Synthetic recording owner' });
    blobRoot = await mkdtemp(path.join(tmpdir(), 'journal-recording-'));
    service = new PostgresRecordingService(
      client.database,
      new LocalBlobStore(blobRoot),
      {
        send: async (_name: string, _data: object, options?: { id?: string }) =>
          options?.id ?? null,
      } as unknown as PgBoss,
      () => now,
    );
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
    if (blobRoot !== undefined)
      await rm(blobRoot, { recursive: true, force: true });
  });

  it('[DATA-020][CAP-002][CAP-004] persists one recording identity and rejects conflicting creation retries', async () => {
    const created = await service.create(
      ownerId,
      createInput,
      'create-recording-1',
      correlationId,
    );
    expect(created).toMatchObject({
      replayed: false,
      recording: {
        id: recordingId,
        contributionId,
        uploadId,
        persistenceState: 'uploading',
      },
    });
    const replay = await service.create(
      ownerId,
      createInput,
      'create-recording-1',
      correlationId,
    );
    expect(replay.replayed).toBe(true);
    await expect(
      service.create(
        ownerId,
        { ...createInput, mimeType: 'audio/ogg' },
        'create-recording-1',
        correlationId,
      ),
    ).rejects.toBeInstanceOf(RecordingConflictError);
  });

  it('[CAP-003][CAP-004] accepts indexed checksum checkpoints idempotently and enforces database uniqueness', async () => {
    const first = await service.uploadChunk(
      ownerId,
      recordingId,
      0,
      sha256('hello '),
      'chunk-0000',
      bytes('hello '),
    );
    expect(first).toMatchObject({ index: 0, byteSize: '6', replayed: false });
    const replay = await service.uploadChunk(
      ownerId,
      recordingId,
      0,
      sha256('hello '),
      'chunk-0000',
      bytes('hello '),
    );
    expect(replay.replayed).toBe(true);
    await expect(
      service.uploadChunk(
        ownerId,
        recordingId,
        0,
        sha256('different'),
        'chunk-conflict',
        bytes('different'),
      ),
    ).rejects.toBeInstanceOf(RecordingConflictError);
    await service.uploadChunk(
      ownerId,
      recordingId,
      1,
      sha256('audio'),
      'chunk-0001',
      bytes('audio'),
    );

    const accepted = await service.getUpload(
      ownerId,
      recordingId,
      undefined,
      1,
    );
    expect(accepted.acceptedIndexes).toEqual([0]);
    expect(accepted.nextAfter).toBe(0);
    expect(
      (await service.getUpload(ownerId, recordingId, accepted.nextAfter, 10))
        .acceptedIndexes,
    ).toEqual([1]);

    await expect(
      client.database.insert(recordingChunks).values({
        uploadId,
        chunkIndex: 0,
        byteSize: 6n,
        sha256: sha256('hello '),
        stagingBlobKey: `${uploadId}/duplicate.chunk`,
      }),
    ).rejects.toThrow();
  });

  it('[DATA-021][CAP-004][CAP-005][AC-002] prepares, streams, confirms, retries, and range-reads immutable audio', async () => {
    const descriptors = [
      `0:6:${sha256('hello ')}\n`,
      `1:5:${sha256('audio')}\n`,
    ].join('');
    const manifest: FinalizeRecordingRequest = {
      manifestVersion: 1,
      chunkCount: '2',
      totalBytes: '11',
      manifestSha256: sha256(descriptors),
      finalSha256: sha256('hello audio'),
      durationMilliseconds: '10000',
    };
    const durable = await service.finalize(
      ownerId,
      recordingId,
      manifest,
      'finalize-recording-1',
    );
    expect(durable.recording).toMatchObject({
      persistenceState: 'durable',
      transcription: {
        state: 'queued',
        runId: expect.any(String),
      },
      byteSize: '11',
      sha256: sha256('hello audio'),
      durationMilliseconds: '10000',
    });
    const journal = new PostgresJournalService(client.database, () => now);
    expect(
      (await journal.getDay(ownerId, '2026-08-22', false))?.contributions[0],
    ).toMatchObject({
      id: contributionId,
      recording: {
        id: recordingId,
        persistenceState: 'durable',
        transcription: {
          state: 'queued',
          runId: expect.any(String),
        },
        byteSize: '11',
        durationMilliseconds: '10000',
      },
    });
    const moved = await journal.move(
      ownerId,
      contributionId,
      { proposedJournalDayId: priorDayId, journalDate: '2026-08-21' },
      0,
      'move-recording-prior-day',
      correlationId,
    );
    expect(moved.contribution).toMatchObject({
      journalDate: '2026-08-21',
      journalDateAssignment: 'user_override',
      capturedTimezone: createInput.capturedTimezone,
    });
    expect(Date.parse(moved.contribution.capturedAt)).toBe(
      Date.parse(createInput.capturedAt),
    );
    expect(
      (
        await service.finalize(
          ownerId,
          recordingId,
          manifest,
          'finalize-recording-1',
        )
      ).replayed,
    ).toBe(true);
    expect(
      (await service.retry(ownerId, recordingId, 'retry-recording-1')).recording
        .persistenceState,
    ).toBe('durable');
    await expect(
      service.finalize(
        ownerId,
        recordingId,
        { ...manifest, finalSha256: '0'.repeat(64) },
        'finalize-recording-conflict',
      ),
    ).rejects.toBeInstanceOf(RecordingConflictError);

    const opened = await service.openAudio(ownerId, recordingId, {
      start: 6n,
      endExclusive: 11n,
    });
    expect(await read(opened.stream)).toBe('audio');
  });

  it('[RET-004][RET-006][RET-007][PORT-004][SEC-008] deletes audio recoverably, invalidates its export, and retains the recording contribution', async () => {
    await client.database.insert(exportRequests).values({
      id: exportId,
      ownerId,
      idempotencyKey: 'recording-soft-delete-export',
      status: 'completed',
      snapshotAt: now,
      expiresAt: new Date('2026-08-23T12:00:00.000Z'),
      archiveBlobKey: `exports/${exportId}.zip`,
      archiveByteSize: 11n,
      archiveSha256: sha256('hello audio'),
    });
    await client.database.insert(exportBlobLeases).values({
      exportId,
      entityId: recordingId,
      blobKind: 'audio',
      blobKey: `recordings/${recordingId}/original`,
      archivePath: `audio/${recordingId}/original`,
      mediaType: 'audio/webm;codecs=opus',
      byteSize: 11n,
      sha256: sha256('hello audio'),
      leaseExpiresAt: new Date('2026-08-23T12:00:00.000Z'),
    });
    const deleted = await service.deleteAudio(
      ownerId,
      recordingId,
      'delete-audio-1',
      correlationId,
    );
    expect(deleted.recording.audioDeletedAt).toBe(now.toISOString());
    expect(
      await client.database
        .select({ status: exportRequests.status })
        .from(exportRequests)
        .where(eq(exportRequests.id, exportId)),
    ).toEqual([{ status: 'invalidated' }]);
    await expect(
      service.openAudio(ownerId, recordingId, { start: 0n, endExclusive: 1n }),
    ).rejects.toBeInstanceOf(RecordingAudioDeletedError);
    const restored = await service.restoreAudio(
      ownerId,
      recordingId,
      'restore-audio-1',
      correlationId,
    );
    expect(restored.recording.audioDeletedAt).toBeUndefined();
    expect(
      await read(
        (
          await service.openAudio(ownerId, recordingId, {
            start: 0n,
            endExclusive: 5n,
          })
        ).stream,
      ),
    ).toBe('hello');
  });
});
