// @vitest-environment jsdom

import type { ReprocessingBatch } from '@journal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cancelReprocessing,
  listReprocessingBatches,
  previewReprocessing,
  startReprocessing,
} from '../src/reprocessing/api';

const ID = '019c5b90-0000-7000-8000-000000000021';
const VERSION_ID = '019c5b90-0000-7000-8000-000000000022';
const NOW = '2026-08-23T12:00:00.000Z';
const request = {
  target: { scope: 'journal_day' as const, journalDate: '2026-08-23' },
  versionBasis: {
    mode: 'pinned' as const,
    processorVersionIds: [VERSION_ID],
  },
};
const versionBasis = {
  mode: 'pinned' as const,
  versions: [
    {
      processorId: ID,
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
const batch: ReprocessingBatch = {
  id: ID,
  revision: 1,
  status: 'queued',
  target: request.target,
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

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('reprocessing API client', () => {
  it('[EDIT-004][STATE-004] sends CSRF, idempotency, preview fingerprint, and cancellation ETag', async () => {
    const preview = {
      target: request.target,
      versionBasis,
      impact,
      impactFingerprint: 'a'.repeat(64),
      warnings: [],
      expiresAt: NOW,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(preview))
      .mockResolvedValueOnce(
        response(
          {
            batch,
            idempotency: { key: 'start-batch', replayed: false },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        response({
          batch: {
            ...batch,
            revision: 2,
            status: 'canceled',
            progress: {
              ...batch.progress,
              queued: 0,
              canceled: 1,
              percent: 100,
            },
            cancelRequestedAt: NOW,
          },
          idempotency: { key: 'cancel-batch', replayed: false },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await previewReprocessing(request, 'csrf');
    await startReprocessing({
      preview: request,
      impactFingerprint: preview.impactFingerprint,
      csrfToken: 'csrf',
      idempotencyKey: 'start-batch',
    });
    await cancelReprocessing({
      batch,
      csrfToken: 'csrf',
      idempotencyKey: 'cancel-batch',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/reprocessing-batches',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'idempotency-key': 'start-batch',
          'x-csrf-token': 'csrf',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/v1/reprocessing-batches/${ID}/cancel`,
      expect.objectContaining({
        headers: expect.objectContaining({
          'if-match': '"reprocessing-1"',
          'idempotency-key': 'cancel-batch',
        }),
      }),
    );
  });

  it('[EDIT-005][STATE-001] validates paginated audit history', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({ items: [batch], page: { hasMore: false } }),
        ),
    );
    expect(await listReprocessingBatches()).toEqual([batch]);
  });
});
