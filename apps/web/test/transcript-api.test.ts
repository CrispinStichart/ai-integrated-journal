import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  editCorrectedTranscript,
  getRecordingTranscripts,
  listTranscriptRevisions,
  retryTranscriptCleanup,
  TranscriptApiError,
} from '../src/transcript/api.js';

const RECORDING_ID = '019c5b90-0000-7000-8000-000000000021';
const TRANSCRIPT_ID = '019c5b90-0000-7000-8000-000000000022';
const REVISION_ID = '019c5b90-0000-7000-8000-000000000023';
const NOW = '2026-08-23T12:00:00.000Z';
const inspector = { recordingId: RECORDING_ID, audioAvailable: true };
const revision = {
  id: REVISION_ID,
  transcriptId: TRANSCRIPT_ID,
  revision: 1,
  text: 'Transcript words',
  authority: 'generated',
  language: { code: 'en' },
  timingAvailability: { segments: 'unknown' },
  segments: [],
  createdAt: NOW,
};

afterEach(() => vi.unstubAllGlobals());

describe('transcript API client', () => {
  it('[AC-010][DATA-026] validates inspector and immutable revision-history responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(inspector), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [revision] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getRecordingTranscripts(RECORDING_ID)).resolves.toEqual(
      inspector,
    );
    await expect(listTranscriptRevisions(TRANSCRIPT_ID)).resolves.toEqual([
      revision,
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/v1/recordings/${RECORDING_ID}/transcripts`,
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('[AC-011][STATE-004] sends corrected edits and cleanup retries with ETags, CSRF, and idempotency keys', async () => {
    const response = JSON.stringify({
      inspector,
      idempotency: { key: 'transcript-edit-1', replayed: false },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(response, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await editCorrectedTranscript({
      transcriptId: TRANSCRIPT_ID,
      revision: 1,
      text: 'Corrected words',
      editReason: 'Name correction',
      csrfToken: 'csrf-token',
      idempotencyKey: 'transcript-edit-1',
    });
    await retryTranscriptCleanup({
      transcriptId: TRANSCRIPT_ID,
      revision: 1,
      csrfToken: 'csrf-token',
      idempotencyKey: 'cleanup-retry-1',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/v1/transcripts/${TRANSCRIPT_ID}`,
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          'idempotency-key': 'transcript-edit-1',
          'if-match': '"revision-1"',
          'x-csrf-token': 'csrf-token',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/transcripts/${TRANSCRIPT_ID}/cleanup/retry`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('[STATE-003] preserves stable stage-specific problem details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Cleanup retry unavailable',
            status: 409,
            code: 'retry_unavailable',
            correlationId: REVISION_ID,
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
      ),
    );

    await expect(
      retryTranscriptCleanup({
        transcriptId: TRANSCRIPT_ID,
        revision: 1,
        csrfToken: 'csrf-token',
        idempotencyKey: 'cleanup-retry-1',
      }),
    ).rejects.toMatchObject<Partial<TranscriptApiError>>({
      status: 409,
      code: 'retry_unavailable',
    });
  });

  it('[STATE-003][SEC-003] fails safely when an upstream error is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('<h1>proxy failure containing transcript text</h1>', {
          status: 503,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    await expect(getRecordingTranscripts(RECORDING_ID)).rejects.toMatchObject<
      Partial<TranscriptApiError>
    >({
      status: 503,
      code: 'unknown',
      message: 'The transcript request failed. Please try again.',
    });
  });
});
