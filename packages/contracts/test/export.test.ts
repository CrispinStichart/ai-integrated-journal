import { describe, expect, it } from 'vitest';

import {
  createExportRequestSchema,
  exportMutationResponseSchema,
  exportResourceSchema,
} from '../src/index.js';

describe('portable export contracts', () => {
  it('[PORT-003][PORT-004][AC-050] keeps raw responses and audio explicit opt-ins', () => {
    expect(createExportRequestSchema.parse({})).toEqual({
      includeAudio: false,
      includeProviderRawResponses: false,
    });
  });

  it('[PORT-005][PORT-007][AC-050] exposes a versioned immutable snapshot and verified archive identity', () => {
    const resource = exportResourceSchema.parse({
      id: '019d2b3c-4000-7000-8000-000000000001',
      status: 'completed',
      manifestSchemaVersion: 1,
      snapshotAt: '2026-08-25T00:00:00.000Z',
      createdAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-08-26T00:00:00.000Z',
      includeAudio: true,
      includeProviderRawResponses: false,
      entityCount: 42,
      fileCount: 8,
      archiveByteSize: '4096',
      archiveSha256: 'a'.repeat(64),
      completedAt: '2026-08-25T00:01:00.000Z',
      downloadAvailable: true,
    });
    expect(resource).toMatchObject({
      manifestSchemaVersion: 1,
      entityCount: 42,
      archiveByteSize: '4096',
    });
    expect(
      exportResourceSchema.parse({
        ...resource,
        archiveByteSize: '9007199254740993',
      }).archiveByteSize,
    ).toBe('9007199254740993');
    expect(
      exportMutationResponseSchema.parse({
        export: resource,
        idempotency: { key: 'export-request-1', replayed: false },
      }),
    ).toMatchObject({ idempotency: { replayed: false } });
  });
});
