import { Temporal } from '@js-temporal/polyfill';

import { DomainInvariantError } from './errors.js';
import { parseJournalDate } from './temporal.js';

export const MAX_REPROCESSING_RANGE_DAYS = 366;
export const MAX_REPROCESSING_RUNS = 10_000;

export function assertBoundedReprocessingRange(
  startDate: string,
  endDate: string,
): number {
  const start = Temporal.PlainDate.from(parseJournalDate(startDate));
  const end = Temporal.PlainDate.from(parseJournalDate(endDate));
  const days = start.until(end, { largestUnit: 'days' }).days + 1;
  if (days < 1)
    throw new DomainInvariantError(
      'Reprocessing end date must be on or after its start date.',
    );
  if (days > MAX_REPROCESSING_RANGE_DAYS)
    throw new DomainInvariantError(
      `Reprocessing ranges cannot exceed ${MAX_REPROCESSING_RANGE_DAYS} calendar days.`,
    );
  return days;
}

export function providerOperationsPerProcessorRun(
  capabilities: readonly string[],
): number {
  return capabilities.filter(
    (capability) =>
      capability === 'structured_generation' || capability === 'embeddings',
  ).length;
}

export interface ReprocessingProgressCounts {
  readonly queued: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly canceled: number;
}

export function reprocessingProgress(
  counts: ReprocessingProgressCounts,
): Readonly<ReprocessingProgressCounts & { total: number; percent: number }> {
  const values = Object.values(counts);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new DomainInvariantError(
      'Reprocessing progress counts must be non-negative safe integers.',
    );
  const total = values.reduce((sum, value) => sum + value, 0);
  const terminal = counts.succeeded + counts.failed + counts.canceled;
  return Object.freeze({
    ...counts,
    total,
    percent: total === 0 ? 100 : Math.round((terminal / total) * 10_000) / 100,
  });
}

export function reprocessingStatus(
  persistedStatus: 'active' | 'canceled',
  counts: ReprocessingProgressCounts,
): 'queued' | 'running' | 'completed' | 'completed_with_failures' | 'canceled' {
  if (persistedStatus === 'canceled') return 'canceled';
  const progress = reprocessingProgress(counts);
  if (progress.total > 0 && progress.queued === progress.total) return 'queued';
  if (progress.queued > 0 || progress.running > 0) return 'running';
  return progress.failed > 0 || progress.canceled > 0
    ? 'completed_with_failures'
    : 'completed';
}
