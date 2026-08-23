import type {
  ReprocessingBatch,
  ReprocessingPreviewResponse,
} from '@journal/contracts';
import { silentLogger } from '@journal/observability';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../src/app.js';
import { createInMemoryEventFeed } from '../src/events.js';
import type { ReprocessingService } from '../src/reprocessing-service.js';

const OWNER_ID = '019c5b90-0000-7000-8000-000000000020';
const BATCH_ID = '019c5b90-0000-7000-8000-000000000021';
const PROCESSOR_ID = '019c5b90-0000-7000-8000-000000000022';
const VERSION_ID = '019c5b90-0000-7000-8000-000000000023';
const CORRELATION_ID = '019c5b90-0000-7000-8000-000000000024';
const NOW = '2026-08-23T12:00:00.000Z';

const versionBasis = {
  mode: 'pinned' as const,
  versions: [
    {
      processorId: PROCESSOR_ID,
      processorName: 'Fixture',
      processorVersionId: VERSION_ID,
      semanticVersion: '1.0.0',
      inputScope: 'journal_day' as const,
      providerOperationsPerRun: 1,
    },
  ],
};
const impact = {
  journalDayCount: 1,
  contributionCount: 1,
  runCount: 1,
  approximateProviderOperationCount: 1,
  staleArtifactCount: 0,
  manualOverrideCount: 0,
};
const preview: ReprocessingPreviewResponse = {
  target: { scope: 'journal_day', journalDate: '2026-08-23' },
  versionBasis,
  impact,
  impactFingerprint: 'a'.repeat(64),
  warnings: [],
  expiresAt: NOW,
};
const batch: ReprocessingBatch = {
  id: BATCH_ID,
  revision: 1,
  status: 'queued',
  target: preview.target,
  versionBasis,
  impact,
  progress: {
    total: 1,
    queued: 1,
    running: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    percent: 0,
  },
  createdAt: NOW,
  updatedAt: NOW,
};

function service(): ReprocessingService {
  return {
    preview: vi.fn(async () => preview),
    start: vi.fn(async () => ({ batch, replayed: false })),
    get: vi.fn(async () => batch),
    list: vi.fn(async () => ({ items: [batch] })),
    cancel: vi.fn(async () => ({
      batch: {
        ...batch,
        revision: 2,
        status: 'canceled' as const,
        progress: {
          ...batch.progress,
          queued: 0,
          canceled: 1,
          percent: 100,
        },
        cancelRequestedAt: NOW,
      },
      replayed: false,
    })),
  };
}

function app(reprocessingService: ReprocessingService) {
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
    reprocessingService,
  });
}

describe('Reprocessing orchestration API', () => {
  it('[EDIT-003][EDIT-004][SEC-001] authenticates preview and preserves its explicit version basis', async () => {
    const reprocessingService = service();
    await request(app(reprocessingService))
      .post('/api/v1/processing-runs/reprocessing/preview')
      .send({
        target: preview.target,
        versionBasis: {
          mode: 'pinned',
          processorVersionIds: [VERSION_ID],
        },
      })
      .expect(401);
    const response = await request(app(reprocessingService))
      .post('/api/v1/processing-runs/reprocessing/preview')
      .set('authorization', 'Bearer valid')
      .send({
        target: preview.target,
        versionBasis: {
          mode: 'pinned',
          processorVersionIds: [VERSION_ID],
        },
      })
      .expect(200);
    expect(response.body).toMatchObject({
      impact: { approximateProviderOperationCount: 1 },
      versionBasis: { versions: [{ processorVersionId: VERSION_ID }] },
    });
  });

  it('[EDIT-004][STATE-004] requires idempotency for confirmation and passes the preview fingerprint', async () => {
    const reprocessingService = service();
    const body = {
      preview: {
        target: preview.target,
        versionBasis: {
          mode: 'pinned',
          processorVersionIds: [VERSION_ID],
        },
      },
      impactFingerprint: preview.impactFingerprint,
    };
    await request(app(reprocessingService))
      .post('/api/v1/reprocessing-batches')
      .set('authorization', 'Bearer valid')
      .send(body)
      .expect(428);
    await request(app(reprocessingService))
      .post('/api/v1/reprocessing-batches')
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'start-batch-1')
      .send(body)
      .expect(201)
      .expect('etag', '"reprocessing-1"');
    expect(reprocessingService.start).toHaveBeenCalledWith(
      OWNER_ID,
      body.preview,
      preview.impactFingerprint,
      'start-batch-1',
      CORRELATION_ID,
    );
  });

  it('[STATE-001][EDIT-005] returns bounded audit history and live progress', async () => {
    const reprocessingService = service();
    const page = await request(app(reprocessingService))
      .get('/api/v1/reprocessing-batches?limit=20')
      .set('authorization', 'Bearer valid')
      .expect(200);
    expect(page.body).toMatchObject({
      items: [{ id: BATCH_ID, progress: { total: 1 } }],
      page: { hasMore: false },
    });
    await request(app(reprocessingService))
      .get(`/api/v1/reprocessing-batches/${BATCH_ID}`)
      .set('authorization', 'Bearer valid')
      .expect(200)
      .expect('etag', '"reprocessing-1"');
  });

  it('[SEC-002] rejects malformed batch identifiers before service access', async () => {
    const reprocessingService = service();
    const response = await request(app(reprocessingService))
      .get('/api/v1/reprocessing-batches/not-a-uuid')
      .set('authorization', 'Bearer valid')
      .expect(400);

    expect(response.body).toMatchObject({
      code: 'validation_failed',
      invalidParameters: [{ name: 'id', location: 'path' }],
    });
    expect(reprocessingService.get).not.toHaveBeenCalled();
  });

  it('[STATE-001][STATE-004] conditionally cancels remaining work', async () => {
    const reprocessingService = service();
    await request(app(reprocessingService))
      .post(`/api/v1/reprocessing-batches/${BATCH_ID}/cancel`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'cancel-batch-1')
      .expect(428);
    const response = await request(app(reprocessingService))
      .post(`/api/v1/reprocessing-batches/${BATCH_ID}/cancel`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'cancel-batch-1')
      .set('if-match', '"reprocessing-1"')
      .expect(200)
      .expect('etag', '"reprocessing-2"');
    expect(response.body.batch).toMatchObject({
      status: 'canceled',
      progress: { canceled: 1, percent: 100 },
    });
  });
});
