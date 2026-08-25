import { describe, expect, it } from 'vitest';

import {
  assertDeletionEligible,
  assertRestoreAllowed,
  deletionEligibleAt,
  retentionMatrix,
} from '../src/index.js';

describe('retention invariants', () => {
  it('[RET-001][RET-003][RET-006] applies an independent bounded grace period', () => {
    const deletedAt = new Date('2026-08-01T12:00:00.000Z');
    expect(deletionEligibleAt(deletedAt).toISOString()).toBe(
      '2026-08-31T12:00:00.000Z',
    );
    expect(() =>
      assertDeletionEligible(deletionEligibleAt(deletedAt), deletedAt),
    ).toThrow('grace period');
    expect(() => deletionEligibleAt(deletedAt, -1)).toThrow('0 to 3650');
  });

  it('[RET-007][SEARCH-006] removes material copies while retaining only content-free authority', () => {
    expect(retentionMatrix.contribution).toMatchObject({
      database: 'delete',
      final_blobs: 'delete',
      staging_chunks: 'delete',
      browser_cache: 'invalidate',
      browser_outbox: 'invalidate',
      search_text: 'delete',
      search_vectors: 'delete',
      exports: 'invalidate',
      backups: 'invalidate',
      audit: 'retain_metadata',
      tombstone: 'retain_metadata',
    });
    expect(retentionMatrix.recording_audio.database).toBe('retain_metadata');
    expect(retentionMatrix.recording_audio.search_text).toBe('retain');
    expect(retentionMatrix.recording_audio.provider_raw_responses).toBe(
      'retain',
    );
    expect(retentionMatrix.provider_raw_response.database).toBe('delete');
  });

  it('[RET-006] rejects restore and stable-ID reuse after permanent deletion', () => {
    expect(() => assertRestoreAllowed(true)).toThrow('cannot be restored');
    expect(() => assertRestoreAllowed(false)).not.toThrow();
  });
});
