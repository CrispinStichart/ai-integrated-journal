import { describe, expect, it } from 'vitest';

import {
  EXPORT_MANIFEST_SCHEMA_VERSION,
  canDownloadExport,
  safeExportPathSegment,
} from '../src/index.js';

describe('portable export invariants', () => {
  it('[PORT-003][AC-050] versions archives and sanitizes portable path segments', () => {
    expect(EXPORT_MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(safeExportPathSegment('../Café / notes')).toBe('Caf-notes');
  });

  it('[RET-006] permits only unexpired completed archives with a durable blob', () => {
    const now = new Date('2026-08-25T12:00:00.000Z');
    expect(
      canDownloadExport({
        status: 'completed',
        expiresAt: new Date('2026-08-26T00:00:00.000Z'),
        now,
        archiveBlobKey: 'exports/archive.zip',
      }),
    ).toBe(true);
    expect(
      canDownloadExport({
        status: 'invalidated',
        expiresAt: new Date('2026-08-26T00:00:00.000Z'),
        now,
        archiveBlobKey: 'exports/archive.zip',
      }),
    ).toBe(false);
  });
});
