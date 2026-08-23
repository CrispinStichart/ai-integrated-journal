import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertBoundedReprocessingRange,
  providerOperationsPerProcessorRun,
  reprocessingProgress,
  reprocessingStatus,
} from '../src/reprocessing.js';

describe('reprocessing orchestration domain', () => {
  it('[EDIT-003][EDIT-004] bounds inclusive historical date ranges', () => {
    expect(assertBoundedReprocessingRange('2024-02-29', '2025-02-28')).toBe(
      366,
    );
    expect(() =>
      assertBoundedReprocessingRange('2024-02-29', '2025-03-01'),
    ).toThrow('cannot exceed 366');
    expect(() =>
      assertBoundedReprocessingRange('2026-08-24', '2026-08-23'),
    ).toThrow('on or after');
  });

  it('[EDIT-004][MODEL-001] estimates only declared provider capabilities', () => {
    expect(
      providerOperationsPerProcessorRun([
        'deterministic',
        'structured_generation',
        'embeddings',
      ]),
    ).toBe(2);
  });

  it('[STATE-001] derives honest progress and terminal failure state', () => {
    expect(
      reprocessingProgress({
        queued: 1,
        running: 1,
        succeeded: 2,
        failed: 1,
        canceled: 0,
      }),
    ).toMatchObject({ total: 5, percent: 60 });
    expect(
      reprocessingStatus('active', {
        queued: 0,
        running: 0,
        succeeded: 2,
        failed: 1,
        canceled: 0,
      }),
    ).toBe('completed_with_failures');
    expect(
      reprocessingStatus('canceled', {
        queued: 0,
        running: 0,
        succeeded: 1,
        failed: 0,
        canceled: 1,
      }),
    ).toBe('canceled');
  });

  it('[STATE-001] property: progress is bounded and reaches 100 exactly when every run is terminal', () => {
    fc.assert(
      fc.property(
        fc.record({
          queued: fc.integer({ min: 0, max: 1_000 }),
          running: fc.integer({ min: 0, max: 1_000 }),
          succeeded: fc.integer({ min: 0, max: 1_000 }),
          failed: fc.integer({ min: 0, max: 1_000 }),
          canceled: fc.integer({ min: 0, max: 1_000 }),
        }),
        (counts) => {
          const progress = reprocessingProgress(counts);
          expect(progress.percent).toBeGreaterThanOrEqual(0);
          expect(progress.percent).toBeLessThanOrEqual(100);
          expect(progress.percent === 100).toBe(
            progress.queued === 0 && progress.running === 0,
          );
        },
      ),
    );
  });
});
