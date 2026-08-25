import { DomainInvariantError } from './errors.js';

export const retentionEntityKinds = [
  'journal_day',
  'contribution',
  'recording_audio',
  'provider_raw_response',
] as const;

export type RetentionEntityKind = (typeof retentionEntityKinds)[number];

export const retentionFacets = [
  'database',
  'final_blobs',
  'staging_chunks',
  'browser_cache',
  'browser_outbox',
  'search_text',
  'search_vectors',
  'exports',
  'backups',
  'provider_raw_responses',
  'audit',
  'tombstone',
] as const;

export type RetentionFacet = (typeof retentionFacets)[number];

export const DEFAULT_DELETION_GRACE_DAYS = 30;
export const DEFAULT_RAW_RESPONSE_RETENTION_DAYS = 30;

/**
 * The explicit matrix is shared by previews, workers, documentation, and tests.
 * `delete` means content is physically removed, `invalidate` means a derived or
 * distributed copy is made unusable, `retain` means unaffected material stays
 * available, and `retain_metadata` is content-free.
 */
export const retentionMatrix: Readonly<
  Record<
    RetentionEntityKind,
    Readonly<
      Record<
        RetentionFacet,
        'delete' | 'invalidate' | 'retain' | 'retain_metadata'
      >
    >
  >
> = Object.freeze({
  journal_day: matrix('delete'),
  contribution: matrix('delete'),
  recording_audio: {
    ...matrix('invalidate'),
    database: 'retain_metadata',
    final_blobs: 'delete',
    staging_chunks: 'delete',
    search_text: 'retain',
    search_vectors: 'retain',
    provider_raw_responses: 'retain',
    audit: 'retain_metadata',
    tombstone: 'retain_metadata',
  },
  provider_raw_response: {
    ...matrix('invalidate'),
    database: 'delete',
    final_blobs: 'delete',
    staging_chunks: 'retain',
    browser_cache: 'retain',
    search_text: 'retain',
    search_vectors: 'retain',
    browser_outbox: 'retain',
    provider_raw_responses: 'delete',
    audit: 'retain_metadata',
    tombstone: 'retain_metadata',
  },
});

function matrix(
  materialAction: 'delete' | 'invalidate',
): Record<
  RetentionFacet,
  'delete' | 'invalidate' | 'retain' | 'retain_metadata'
> {
  return {
    database: materialAction,
    final_blobs: materialAction,
    staging_chunks: materialAction,
    browser_cache: 'invalidate',
    browser_outbox: 'invalidate',
    search_text: materialAction,
    search_vectors: materialAction,
    exports: 'invalidate',
    backups: 'invalidate',
    provider_raw_responses: materialAction,
    audit: 'retain_metadata',
    tombstone: 'retain_metadata',
  };
}

export function deletionEligibleAt(
  deletedAt: Date,
  graceDays = DEFAULT_DELETION_GRACE_DAYS,
): Date {
  if (!Number.isSafeInteger(graceDays) || graceDays < 0 || graceDays > 3_650) {
    throw new DomainInvariantError(
      'Deletion grace days must be from 0 to 3650.',
    );
  }
  return new Date(deletedAt.getTime() + graceDays * 86_400_000);
}

export function assertDeletionEligible(eligibleAt: Date, now: Date): void {
  if (eligibleAt.getTime() > now.getTime()) {
    throw new DomainInvariantError(
      'The recoverable deletion grace period has not elapsed.',
    );
  }
}

export function assertRestoreAllowed(tombstoned: boolean): void {
  if (tombstoned) {
    throw new DomainInvariantError(
      'A permanently deleted stable identity cannot be restored or reused.',
    );
  }
}
