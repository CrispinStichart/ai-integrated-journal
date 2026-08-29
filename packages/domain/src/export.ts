export const EXPORT_ARCHIVE_FORMAT = 'journal-portable-export' as const;
export const EXPORT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const EXPORT_DOWNLOAD_TTL_MILLISECONDS = 24 * 60 * 60 * 1_000;

export const EXPORT_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'invalidated',
  'expired',
] as const;

export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export function canDownloadExport(input: {
  readonly status: ExportStatus;
  readonly expiresAt: Date;
  readonly now: Date;
  readonly archiveBlobKey?: string | null;
}): boolean {
  return (
    input.status === 'completed' &&
    input.expiresAt > input.now &&
    Boolean(input.archiveBlobKey)
  );
}

export function safeExportPathSegment(value: string): string {
  const safe = value
    .normalize('NFC')
    .replaceAll(/[^A-Za-z0-9_-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return safe.length > 0 ? safe : 'item';
}
