import { createHash } from 'node:crypto';

import type { RecordingResource } from '@journal/contracts';
import { silentLogger } from '@journal/observability';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createApiApp } from '../src/app.js';
import { createInMemoryEventFeed } from '../src/events.js';
import {
  AUDIO_DELETION_WARNING,
  RecordingConflictError,
  type RecordingService,
} from '../src/recording-service.js';

const OWNER_ID = '019c5b90-0000-7000-8000-000000000020';
const RECORDING_ID = '019c5b90-0000-7000-8000-000000000021';
const CONTRIBUTION_ID = '019c5b90-0000-7000-8000-000000000022';
const UPLOAD_ID = '019c5b90-0000-7000-8000-000000000023';
const DAY_ID = '019c5b90-0000-7000-8000-000000000024';
const CORRELATION_ID = '019c5b90-0000-7000-8000-000000000025';
const checksum = createHash('sha256').update('audio').digest('hex');

const recording: RecordingResource = {
  id: RECORDING_ID,
  contributionId: CONTRIBUTION_ID,
  uploadId: UPLOAD_ID,
  mimeType: 'audio/webm;codecs=opus',
  codec: 'opus',
  persistenceState: 'uploading',
  createdAt: '2026-08-22T12:00:00.000Z',
  updatedAt: '2026-08-22T12:00:00.000Z',
};
const durableRecording: RecordingResource = {
  ...recording,
  persistenceState: 'durable',
  byteSize: '5',
  sha256: checksum,
};

function service(): RecordingService {
  return {
    create: vi.fn(async () => ({ recording, replayed: false })),
    uploadChunk: vi.fn(async () => ({
      index: 0,
      byteSize: '5',
      sha256: checksum,
      replayed: false,
    })),
    getUpload: vi.fn(async () => ({ recording, acceptedIndexes: [0] })),
    finalize: vi.fn(async () => ({
      recording: durableRecording,
      replayed: false,
    })),
    retry: vi.fn(async () => ({ recording: durableRecording, replayed: true })),
    retryTranscription: vi.fn(async () => ({
      recording: {
        ...durableRecording,
        transcription: { state: 'queued' as const, runId: RECORDING_ID },
      },
      replayed: false,
    })),
    openAudio: vi.fn(async () => ({
      recording: durableRecording,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('audio'));
          controller.close();
        },
      }),
    })),
    deleteAudio: vi.fn(async () => ({
      recording: {
        ...durableRecording,
        audioDeletedAt: '2026-08-22T13:00:00.000Z',
      },
      warning: AUDIO_DELETION_WARNING,
      replayed: false,
    })),
    restoreAudio: vi.fn(async () => ({
      recording: durableRecording,
      replayed: false,
    })),
  };
}

function app(recordingService: RecordingService) {
  return createApiApp({
    authenticator: {
      authenticate: async (incoming) =>
        incoming.get('authorization') === 'Bearer valid'
          ? { ownerId: OWNER_ID }
          : undefined,
    },
    createCorrelationId: () => CORRELATION_ID,
    eventFeed: createInMemoryEventFeed(),
    healthProbes: [],
    logger: silentLogger,
    recordingService,
  });
}

const createBody = {
  recordingId: RECORDING_ID,
  contributionId: CONTRIBUTION_ID,
  uploadId: UPLOAD_ID,
  proposedJournalDayId: DAY_ID,
  mimeType: 'audio/webm;codecs=opus',
  codec: 'opus',
  capturedAt: '2026-08-22T12:00:00.000Z',
  capturedTimezone: 'America/New_York',
  journalTimezone: 'America/New_York',
  journalDate: '2026-08-22',
  journalDateAssignment: 'default',
};

describe('Recording upload API', () => {
  it('[CAP-002][CAP-004][DATA-020] creates a client-identified recording idempotently', async () => {
    const recordingService = service();
    const response = await request(app(recordingService))
      .post('/api/v1/recordings')
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'recording-create-1')
      .send(createBody)
      .expect(201);
    expect(response.body.recording).toMatchObject({
      id: RECORDING_ID,
      uploadId: UPLOAD_ID,
      persistenceState: 'uploading',
    });
    expect(recordingService.create).toHaveBeenCalledWith(
      OWNER_ID,
      createBody,
      'recording-create-1',
      CORRELATION_ID,
    );

    const missingKey = await request(app(service()))
      .post('/api/v1/recordings')
      .set('authorization', 'Bearer valid')
      .send(createBody)
      .expect(428);
    expect(missingKey.body.code).toBe('idempotency_key_required');
  });

  it('[CAP-003][CAP-004][CAP-005] streams checksummed bounded chunks and exposes resume indexes', async () => {
    const recordingService = service();
    await request(app(recordingService))
      .put(`/api/v1/recordings/${RECORDING_ID}/chunks/0`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'recording-chunk-1')
      .set('x-content-sha256', checksum)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('audio'))
      .expect(201, {
        chunk: { index: 0, byteSize: '5', sha256: checksum },
        replayed: false,
      });
    expect(recordingService.uploadChunk).toHaveBeenCalledWith(
      OWNER_ID,
      RECORDING_ID,
      0,
      checksum,
      'recording-chunk-1',
      expect.anything(),
    );

    const resumed = await request(app(recordingService))
      .get(`/api/v1/recordings/${RECORDING_ID}/upload?after=0&limit=10`)
      .set('authorization', 'Bearer valid')
      .expect(200);
    expect(resumed.body.acceptedIndexes).toEqual([0]);

    const missingChecksum = await request(app(service()))
      .put(`/api/v1/recordings/${RECORDING_ID}/chunks/1`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'recording-chunk-missing-checksum')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('audio'))
      .expect(400);
    expect(missingChecksum.body.code).toBe('validation_failed');

    const oversized = await request(app(service()))
      .put(`/api/v1/recordings/${RECORDING_ID}/chunks/1`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'recording-chunk-2')
      .set('x-content-sha256', checksum)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.alloc(8 * 1024 * 1024 + 1))
      .expect(413);
    expect(oversized.body.code).toBe('payload_too_large');
  });

  it('[CAP-003][CAP-005][STATE-003] reports host disk exhaustion as retryable storage pressure without changing the recording identity', async () => {
    const recordingService = service();
    const exhausted = Object.assign(new Error('Synthetic disk is full'), {
      code: 'ENOSPC',
    });
    vi.mocked(recordingService.uploadChunk).mockRejectedValueOnce(exhausted);

    const failed = await request(app(recordingService))
      .put(`/api/v1/recordings/${RECORDING_ID}/chunks/0`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'recording-chunk-storage-pressure')
      .set('x-content-sha256', checksum)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('audio'))
      .expect(507);
    expect(failed.body).toMatchObject({
      code: 'server_storage_exhausted',
      correlationId: CORRELATION_ID,
    });
    expect(JSON.stringify(failed.body)).not.toContain(exhausted.message);

    await request(app(recordingService))
      .put(`/api/v1/recordings/${RECORDING_ID}/chunks/0`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'recording-chunk-storage-pressure')
      .set('x-content-sha256', checksum)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('audio'))
      .expect(201);
    expect(recordingService.uploadChunk).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(recordingService.uploadChunk)
        .mock.calls.map((call) => call.slice(0, 5)),
    ).toEqual([
      [OWNER_ID, RECORDING_ID, 0, checksum, 'recording-chunk-storage-pressure'],
      [OWNER_ID, RECORDING_ID, 0, checksum, 'recording-chunk-storage-pressure'],
    ]);
  });

  it('[CAP-004][AC-002] finalizes and explicitly retries a prepared manifest', async () => {
    const recordingService = service();
    const manifest = {
      manifestVersion: 1,
      chunkCount: '1',
      totalBytes: '5',
      manifestSha256: checksum,
      finalSha256: checksum,
      durationMilliseconds: '5000',
    };
    await request(app(recordingService))
      .post(`/api/v1/recordings/${RECORDING_ID}/finalize`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'recording-finalize-1')
      .send(manifest)
      .expect(200);
    await request(app(recordingService))
      .post(`/api/v1/recordings/${RECORDING_ID}/retry`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'recording-retry-1')
      .expect(200);
    await request(app(recordingService))
      .post(`/api/v1/recordings/${RECORDING_ID}/transcription/retry`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'transcription-retry-1')
      .expect(200);
    expect(recordingService.finalize).toHaveBeenCalledWith(
      OWNER_ID,
      RECORDING_ID,
      manifest,
      'recording-finalize-1',
    );
    expect(recordingService.retry).toHaveBeenCalledOnce();
    expect(recordingService.retryTranscription).toHaveBeenCalledWith(
      OWNER_ID,
      RECORDING_ID,
      'transcription-retry-1',
    );
  });

  it('[CAP-005][RET-002] serves only bounded byte ranges with playback metadata', async () => {
    const recordingService = service();
    vi.mocked(recordingService.getUpload).mockResolvedValueOnce({
      recording: durableRecording,
      acceptedIndexes: [0],
    });
    const response = await request(app(recordingService))
      .get(`/api/v1/recordings/${RECORDING_ID}/audio`)
      .set('authorization', 'Bearer valid')
      .set('range', 'bytes=0-4')
      .buffer(true)
      .expect(206);
    expect(response.headers['content-range']).toBe('bytes 0-4/5');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.from(response.body).toString()).toBe('audio');
    expect(recordingService.openAudio).toHaveBeenCalledWith(
      OWNER_ID,
      RECORDING_ID,
      { start: 0n, endExclusive: 5n },
    );

    vi.mocked(recordingService.getUpload).mockResolvedValueOnce({
      recording: durableRecording,
      acceptedIndexes: [0],
    });
    const unsatisfiable = await request(app(recordingService))
      .get(`/api/v1/recordings/${RECORDING_ID}/audio`)
      .set('authorization', 'Bearer valid')
      .set('range', 'bytes=10-20')
      .expect(416);
    expect(unsatisfiable.body.code).toBe('range_not_satisfiable');
  });

  it('[RET-004][RET-006][SEC-008] soft-deletes and restores audio independently', async () => {
    const recordingService = service();
    const deleted = await request(app(recordingService))
      .delete(`/api/v1/recordings/${RECORDING_ID}/audio`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'audio-delete-1')
      .expect(200);
    expect(deleted.body.warning).toBe(AUDIO_DELETION_WARNING);
    await request(app(recordingService))
      .post(`/api/v1/recordings/${RECORDING_ID}/audio/restore`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'audio-restore-1')
      .expect(200);
    expect(recordingService.deleteAudio).toHaveBeenCalledOnce();
    expect(recordingService.restoreAudio).toHaveBeenCalledOnce();
  });

  it('[CAP-004][SEC-001] isolates owners and returns stable conflicts', async () => {
    await request(app(service()))
      .get(`/api/v1/recordings/${RECORDING_ID}/upload`)
      .expect(401);
    const recordingService = service();
    vi.mocked(recordingService.finalize).mockRejectedValueOnce(
      new RecordingConflictError(),
    );
    const response = await request(app(recordingService))
      .post(`/api/v1/recordings/${RECORDING_ID}/finalize`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'recording-finalize-2')
      .send({
        manifestVersion: 1,
        chunkCount: '0',
        totalBytes: '0',
        manifestSha256: '0'.repeat(64),
        finalSha256: '0'.repeat(64),
      })
      .expect(409);
    expect(response.body).toMatchObject({
      code: 'conflict',
      correlationId: CORRELATION_ID,
    });
  });
});
