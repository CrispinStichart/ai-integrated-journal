import type {
  RecordingTranscriptInspector,
  TranscriptRevisionResource,
} from '@journal/contracts';
import { silentLogger } from '@journal/observability';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../src/app.js';
import { createInMemoryEventFeed } from '../src/events.js';
import {
  TranscriptConflictError,
  type TranscriptService,
} from '../src/transcript-service.js';

const OWNER_ID = '019c5b90-0000-7000-8000-000000000020';
const RECORDING_ID = '019c5b90-0000-7000-8000-000000000021';
const RAW_ID = '019c5b90-0000-7000-8000-000000000022';
const RAW_REVISION_ID = '019c5b90-0000-7000-8000-000000000023';
const CORRECTED_ID = '019c5b90-0000-7000-8000-000000000024';
const CORRECTED_REVISION_ID = '019c5b90-0000-7000-8000-000000000025';
const CLEANED_ID = '019c5b90-0000-7000-8000-000000000026';
const CLEANED_REVISION_ID = '019c5b90-0000-7000-8000-000000000027';
const RUN_ID = '019c5b90-0000-7000-8000-000000000028';
const SEGMENT_ID = '019c5b90-0000-7000-8000-000000000029';
const NOW = '2026-08-23T12:00:00.000Z';

const rawRevision: TranscriptRevisionResource = {
  id: RAW_REVISION_ID,
  transcriptId: RAW_ID,
  revision: 1,
  text: 'Raw provider words',
  authority: 'generated',
  sourceRunId: RUN_ID,
  language: { code: 'en' },
  timingAvailability: { segments: 'known' },
  segments: [
    {
      id: SEGMENT_ID,
      ordinal: 0,
      startUtf16: 0,
      endUtf16: 18,
      quote: 'Raw provider words',
      timing: {
        status: 'known',
        startMilliseconds: '1200',
        endMilliseconds: '2600',
      },
    },
  ],
  createdAt: NOW,
};

const inspector: RecordingTranscriptInspector = {
  recordingId: RECORDING_ID,
  audioAvailable: true,
  transcription: {
    id: RUN_ID,
    stage: 'transcription',
    status: 'succeeded',
    attempt: 1,
    retryable: false,
    queuedAt: NOW,
    completedAt: NOW,
  },
  rawStt: {
    id: RAW_ID,
    recordingId: RECORDING_ID,
    layer: 'raw_stt',
    revisionCount: 1,
    currentRevision: rawRevision,
    createdAt: NOW,
    updatedAt: NOW,
  },
  corrected: {
    id: CORRECTED_ID,
    recordingId: RECORDING_ID,
    layer: 'corrected',
    revisionCount: 1,
    currentRevision: {
      ...rawRevision,
      id: CORRECTED_REVISION_ID,
      transcriptId: CORRECTED_ID,
      sourceRunId: undefined,
      sourceRevisionId: RAW_REVISION_ID,
    },
    createdAt: NOW,
    updatedAt: NOW,
  },
  cleaned: {
    id: CLEANED_ID,
    recordingId: RECORDING_ID,
    layer: 'cleaned',
    revisionCount: 1,
    currentRevision: {
      ...rawRevision,
      id: CLEANED_REVISION_ID,
      transcriptId: CLEANED_ID,
      text: 'Clean words',
      sourceRunId: undefined,
      sourceRevisionId: CORRECTED_REVISION_ID,
      segments: [],
    },
    createdAt: NOW,
    updatedAt: NOW,
  },
};

function service(): TranscriptService {
  return {
    inspect: vi.fn(async () => inspector),
    history: vi.fn(async () => [rawRevision]),
    editCorrected: vi.fn(async () => ({ inspector, replayed: false })),
    retryCleanup: vi.fn(async () => ({ inspector, replayed: false })),
  };
}

function app(transcriptService: TranscriptService) {
  return createApiApp({
    authenticator: {
      authenticate: async (incoming) =>
        incoming.get('authorization') === 'Bearer valid'
          ? { ownerId: OWNER_ID }
          : undefined,
    },
    createCorrelationId: () => RUN_ID,
    eventFeed: createInMemoryEventFeed(),
    healthProbes: [],
    logger: silentLogger,
    transcriptService,
  });
}

describe('Transcript inspector API', () => {
  it('[AC-010][DATA-022][DATA-024][DATA-025] returns distinct immutable raw, corrected, and cleaned artifacts', async () => {
    const transcriptService = service();
    const response = await request(app(transcriptService))
      .get(`/api/v1/recordings/${RECORDING_ID}/transcripts`)
      .set('authorization', 'Bearer valid')
      .expect(200);

    expect(response.body).toMatchObject({
      rawStt: {
        layer: 'raw_stt',
        currentRevision: { text: 'Raw provider words' },
      },
      corrected: { layer: 'corrected' },
      cleaned: { layer: 'cleaned', currentRevision: { text: 'Clean words' } },
    });
    expect(response.headers.etag).toBe('"revision-1"');
    expect(transcriptService.inspect).toHaveBeenCalledWith(
      OWNER_ID,
      RECORDING_ID,
    );
  });

  it('[AC-011][DATA-026][EDIT-001] conditionally appends a corrected revision without accepting a raw-layer mutation', async () => {
    const transcriptService = service();
    await request(app(transcriptService))
      .patch(`/api/v1/transcripts/${CORRECTED_ID}`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'corrected-edit-1')
      .set('if-match', '"revision-1"')
      .send({ text: 'Corrected human words', editReason: 'Name correction' })
      .expect(200);

    expect(transcriptService.editCorrected).toHaveBeenCalledWith(
      OWNER_ID,
      CORRECTED_ID,
      1,
      'Corrected human words',
      'Name correction',
      'corrected-edit-1',
      RUN_ID,
    );

    const missingCondition = await request(app(service()))
      .patch(`/api/v1/transcripts/${CORRECTED_ID}`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'corrected-edit-2')
      .send({ text: 'Unsafe edit' })
      .expect(428);
    expect(missingCondition.body.code).toBe('precondition_required');
  });

  it('[STATE-003][STATE-004] exposes an idempotent stage-specific cleanup retry', async () => {
    const transcriptService = service();
    await request(app(transcriptService))
      .post(`/api/v1/transcripts/${CORRECTED_ID}/cleanup/retry`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'cleanup-retry-1')
      .set('if-match', '"revision-1"')
      .expect(200);
    expect(transcriptService.retryCleanup).toHaveBeenCalledWith(
      OWNER_ID,
      CORRECTED_ID,
      1,
      'cleanup-retry-1',
      RUN_ID,
    );

    vi.mocked(transcriptService.retryCleanup).mockRejectedValueOnce(
      new TranscriptConflictError(),
    );
    const conflict = await request(app(transcriptService))
      .post(`/api/v1/transcripts/${CORRECTED_ID}/cleanup/retry`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'cleanup-retry-2')
      .set('if-match', '"revision-1"')
      .expect(412);
    expect(conflict.body.code).toBe('etag_mismatch');
  });

  it('[SEC-001] isolates transcript inspection and history behind ownership authentication', async () => {
    await request(app(service()))
      .get(`/api/v1/recordings/${RECORDING_ID}/transcripts`)
      .expect(401);
    const transcriptService = service();
    await request(app(transcriptService))
      .get(`/api/v1/transcripts/${RAW_ID}/revisions`)
      .set('authorization', 'Bearer valid')
      .expect(200, { items: [rawRevision] });
    expect(transcriptService.history).toHaveBeenCalledWith(OWNER_ID, RAW_ID);
  });
});
