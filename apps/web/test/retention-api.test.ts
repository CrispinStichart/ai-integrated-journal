// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgeDeletionLedger,
  drainDeletionLedger,
  requestPermanentDeletion,
  synchronizeDeletionLedger,
} from '../src/retention/api';

const TARGET_ID = '019d2b3c-4000-7000-8000-000000000002';

afterEach(() => vi.unstubAllGlobals());

describe('retention browser API', () => {
  it('[RET-005][SEC-008] sends the exact destructive confirmation with CSRF', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            deletion: {
              id: '019d2b3c-4000-7000-8000-000000000003',
              target: { entityKind: 'contribution', entityId: TARGET_ID },
              status: 'pending',
              generation: 1,
              requestedAt: '2026-08-25T00:00:00.000Z',
              eligibleAt: '2026-08-24T00:00:00.000Z',
              attempts: 0,
              backupCheckpoint: 'not_configured',
            },
            replayed: false,
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await requestPermanentDeletion(
      { entityKind: 'contribution', entityId: TARGET_ID },
      'csrf-token',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/retention/permanent-deletions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-csrf-token': 'csrf-token' }),
        body: JSON.stringify({
          entityKind: 'contribution',
          entityId: TARGET_ID,
          confirmation: 'PERMANENTLY DELETE',
        }),
      }),
    );
  });

  it('[RET-006][RET-007] keeps retrieval and post-purge acknowledgement explicitly ordered', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                entityKind: 'contribution',
                entityId: TARGET_ID,
                deletedAt: '2026-08-25T00:00:00.000Z',
                generation: 4,
              },
            ],
            latestGeneration: 4,
            hasMore: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await synchronizeDeletionLedger(3);
    expect(page.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await acknowledgeDeletionLedger(4, 'csrf-token');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/v1/retention/browser-purge-acknowledgements',
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ generation: 4 }),
    });
  });

  it('[RET-006][RET-007] drains every bounded page before allowing offline replay to continue', async () => {
    const secondId = '019d2b3c-4000-7000-8000-000000000004';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                entityKind: 'contribution',
                entityId: TARGET_ID,
                deletedAt: '2026-08-25T00:00:00.000Z',
                generation: 4,
              },
            ],
            latestGeneration: 5,
            hasMore: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                entityKind: 'recording_audio',
                entityId: secondId,
                deletedAt: '2026-08-25T00:01:00.000Z',
                generation: 5,
              },
            ],
            latestGeneration: 5,
            hasMore: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const applied: Array<{ id: string; generation: number }> = [];

    await expect(
      drainDeletionLedger(3, async (items, generation) => {
        applied.push({ id: items[0]?.entityId ?? '', generation });
      }),
    ).resolves.toEqual({ appliedGeneration: 5, latestGeneration: 5 });

    expect(applied).toEqual([
      { id: TARGET_ID, generation: 4 },
      { id: secondId, generation: 5 },
    ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/retention/tombstones?afterGeneration=3&limit=500',
      '/api/v1/retention/tombstones?afterGeneration=4&limit=500',
    ]);
  });
});
