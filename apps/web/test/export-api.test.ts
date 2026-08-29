// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPortableExport,
  exportDownloadUrl,
  listPortableExports,
} from '../src/export/api';

const EXPORT_ID = '019d2b3c-4000-7000-8000-000000000002';
const resource = {
  id: EXPORT_ID,
  status: 'queued',
  manifestSchemaVersion: 1,
  snapshotAt: '2026-08-25T00:00:00.000Z',
  createdAt: '2026-08-25T00:00:00.000Z',
  expiresAt: '2026-08-26T00:00:00.000Z',
  includeAudio: false,
  includeProviderRawResponses: false,
  entityCount: 5,
  fileCount: 0,
  downloadAvailable: false,
};

afterEach(() => vi.unstubAllGlobals());

describe('export browser API', () => {
  it('[PORT-003][AC-050] sends explicit selections with session CSRF', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            export: resource,
            idempotency: {
              key: 'export-idempotency-key',
              replayed: false,
            },
          }),
          {
            status: 202,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await createPortableExport(
      { includeAudio: false, includeProviderRawResponses: false },
      'csrf',
      'export-idempotency-key',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/exports',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'idempotency-key': 'export-idempotency-key',
          'x-csrf-token': 'csrf',
        }),
      }),
    );
  });

  it('[PORT-006] lists export state and produces a same-origin download URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ items: [resource] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(listPortableExports()).resolves.toHaveLength(1);
    expect(exportDownloadUrl(EXPORT_ID)).toBe(
      `/api/v1/exports/${EXPORT_ID}/download`,
    );
  });
});
