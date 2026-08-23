// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRecording,
  finalizeRecording,
  getRecordingUpload,
  recordingAudioUrl,
  RecordingApiError,
  retryRecordingFinalization,
  retryRecordingTranscription,
  uploadRecordingChunk,
} from '../src/recording/api';

const IDS = {
  owner: '018f0000-0000-7000-8000-000000000001',
  day: '018f0000-0000-7000-8000-000000000002',
  recording: '018f0000-0000-7000-8000-000000000003',
  contribution: '018f0000-0000-7000-8000-000000000004',
  upload: '018f0000-0000-7000-8000-000000000005',
  correlation: '018f0000-0000-7000-8000-000000000006',
} as const;
const CHECKSUM = 'a'.repeat(64);
const recording = {
  id: IDS.recording,
  contributionId: IDS.contribution,
  uploadId: IDS.upload,
  mimeType: 'audio/webm;codecs=opus',
  codec: 'opus',
  persistenceState: 'uploading' as const,
  createdAt: '2026-08-22T12:00:00.000Z',
  updatedAt: '2026-08-22T12:00:00.000Z',
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mutation(resource = recording) {
  return {
    recording: resource,
    idempotency: { key: `create-${IDS.recording}`, replayed: false },
  };
}

describe('recording browser API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('[CAP-003][CAP-004] sends every resumable protocol operation with stable identity and integrity metadata', async () => {
    const durable = {
      ...recording,
      persistenceState: 'durable' as const,
      durationMilliseconds: '5000',
      byteSize: '3',
      sha256: CHECKSUM,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(mutation(recording), 201))
      .mockResolvedValueOnce(
        json({ recording, acceptedIndexes: [0], nextAfter: 0 }),
      )
      .mockResolvedValueOnce(json({ recording, acceptedIndexes: [1] }))
      .mockResolvedValueOnce(
        json({
          chunk: { index: 1, byteSize: '3', sha256: CHECKSUM },
          replayed: false,
        }),
      )
      .mockResolvedValueOnce(json(mutation(durable)))
      .mockResolvedValueOnce(json(mutation(durable)))
      .mockResolvedValueOnce(json(mutation(durable)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createRecording(
        {
          recordingId: IDS.recording,
          contributionId: IDS.contribution,
          uploadId: IDS.upload,
          proposedJournalDayId: IDS.day,
          mimeType: recording.mimeType,
          codec: 'opus',
          capturedAt: '2026-08-22T12:00:00.000Z',
          capturedTimezone: 'UTC',
          journalTimezone: 'UTC',
          journalDate: '2026-08-22',
          journalDateAssignment: 'default',
        },
        'csrf-token',
      ),
    ).resolves.toEqual(recording);
    await expect(getRecordingUpload(IDS.recording)).resolves.toMatchObject({
      acceptedIndexes: [0],
      nextAfter: 0,
    });
    await expect(getRecordingUpload(IDS.recording, 0)).resolves.toMatchObject({
      acceptedIndexes: [1],
    });
    await uploadRecordingChunk(
      IDS.recording,
      1,
      CHECKSUM,
      new Uint8Array([1, 2, 3]).buffer,
      'csrf-token',
    );
    await expect(
      finalizeRecording(
        IDS.recording,
        {
          manifestVersion: 1,
          chunkCount: '1',
          totalBytes: '3',
          manifestSha256: CHECKSUM,
          finalSha256: CHECKSUM,
          durationMilliseconds: '5000',
        },
        'csrf-token',
      ),
    ).resolves.toEqual(durable);
    await expect(
      retryRecordingFinalization(IDS.recording, 'csrf-token'),
    ).resolves.toEqual(durable);
    await expect(
      retryRecordingTranscription(
        IDS.recording,
        'csrf-token',
        'transcription-retry-1',
      ),
    ).resolves.toEqual(durable);

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[1]?.[0]).not.toContain('after=');
    expect(fetchMock.mock.calls[2]?.[0]).toContain('after=0');
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: 'PUT',
      headers: expect.objectContaining({
        'idempotency-key': `chunk-${IDS.recording}-1`,
        'x-content-sha256': CHECKSUM,
        'x-csrf-token': 'csrf-token',
      }),
    });
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[6]).toEqual([
      `/api/v1/recordings/${IDS.recording}/transcription/retry`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'idempotency-key': 'transcription-retry-1',
        }),
      }),
    ]);
    expect(recordingAudioUrl(IDS.recording)).toBe(
      `/api/v1/recordings/${IDS.recording}/audio`,
    );
  });

  it('[CAP-006] exposes stable problem detail and fallback errors for safe retry decisions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            type: 'about:blank',
            title: 'Storage unavailable',
            detail: 'Durable storage needs more free space.',
            status: 507,
            code: 'server_storage_exhausted',
            correlationId: IDS.correlation,
          },
          507,
        ),
      )
      .mockResolvedValueOnce(
        json(
          {
            type: 'about:blank',
            title: 'Recording not found',
            status: 404,
            code: 'not_found',
            correlationId: IDS.correlation,
          },
          404,
        ),
      )
      .mockResolvedValueOnce(new Response('not-json', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getRecordingUpload(IDS.recording)).rejects.toMatchObject({
      name: 'RecordingApiError',
      message: 'Durable storage needs more free space.',
      status: 507,
      code: 'server_storage_exhausted',
    });
    await expect(getRecordingUpload(IDS.recording)).rejects.toMatchObject({
      message: 'Recording not found',
      code: 'not_found',
    });
    const unknown = await getRecordingUpload(IDS.recording).catch(
      (error: unknown) => error,
    );
    expect(unknown).toBeInstanceOf(RecordingApiError);
    expect(unknown).toMatchObject({
      message: 'Audio synchronization failed. Please try again.',
      status: 503,
      code: 'unknown',
    });
  });
});
