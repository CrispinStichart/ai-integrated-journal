import type { ExportResource } from '@journal/contracts';
import { silentLogger } from '@journal/observability';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../src/app.js';
import type { ExportService } from '../src/export-service.js';

const OWNER_ID = '019d2b3c-4000-7000-8000-000000000001';
const EXPORT_ID = '019d2b3c-4000-7000-8000-000000000002';

const resource: ExportResource = {
  id: EXPORT_ID,
  status: 'completed',
  manifestSchemaVersion: 1,
  snapshotAt: '2026-08-25T00:00:00.000Z',
  createdAt: '2026-08-25T00:00:00.000Z',
  expiresAt: '2026-08-26T00:00:00.000Z',
  includeAudio: true,
  includeProviderRawResponses: false,
  entityCount: 12,
  fileCount: 4,
  archiveByteSize: '3',
  archiveSha256: 'a'.repeat(64),
  completedAt: '2026-08-25T00:01:00.000Z',
  downloadAvailable: true,
};

function service(): ExportService {
  const queued: ExportResource = {
    ...resource,
    status: 'queued',
    downloadAvailable: false,
  };
  return {
    create: vi.fn(async () => ({ export: queued, replayed: false })),
    get: vi.fn(async () => resource),
    list: vi.fn(async () => [resource]),
    download: vi.fn(async () => ({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
      byteSize: 3n,
      sha256: 'a'.repeat(64),
    })),
  };
}

function app(exportService: ExportService, authenticated = true) {
  return createApiApp({
    authenticator: {
      authenticate: vi.fn(async () =>
        authenticated ? { ownerId: OWNER_ID } : undefined,
      ),
    },
    eventFeed: {
      poll: vi.fn(async () => []),
      watch: vi.fn(async () => () => undefined),
    },
    exportService,
    healthProbes: [],
    logger: silentLogger,
  });
}

describe('export routes', () => {
  it('[PORT-003][PORT-004][AC-050] starts an owner-scoped point-in-time export with explicit binary selections', async () => {
    const exports = service();
    await request(app(exports))
      .post('/api/v1/exports')
      .set('Idempotency-Key', 'export-fixture-key')
      .send({ includeAudio: true, includeProviderRawResponses: false })
      .expect(202);
    expect(exports.create).toHaveBeenCalledWith(
      OWNER_ID,
      { includeAudio: true, includeProviderRawResponses: false },
      'export-fixture-key',
      expect.any(String),
    );
  });

  it('[ARCH-005] requires an idempotency key for export creation', async () => {
    await request(app(service()))
      .post('/api/v1/exports')
      .send({ includeAudio: false, includeProviderRawResponses: false })
      .expect(428);
  });

  it('[PORT-003][SEC-001] protects export history and streams only available owner archives', async () => {
    await request(app(service(), false)).get('/api/v1/exports').expect(401);
    const exports = service();
    const response = await request(app(exports))
      .get(`/api/v1/exports/${EXPORT_ID}/download`)
      .expect(200);
    expect(response.headers['content-type']).toContain('application/zip');
    expect(response.headers['x-content-sha256']).toBe('a'.repeat(64));
    expect(response.headers['content-length']).toBe('3');
    expect(exports.download).toHaveBeenCalledWith(
      OWNER_ID,
      EXPORT_ID,
      expect.any(String),
    );
  });

  it('[RET-006] refuses invalidated or incomplete downloads without leaking a blob', async () => {
    const exports = service();
    vi.mocked(exports.download).mockResolvedValueOnce(undefined);
    await request(app(exports))
      .get(`/api/v1/exports/${EXPORT_ID}/download`)
      .expect(409);
  });
});
