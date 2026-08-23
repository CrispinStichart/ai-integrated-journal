import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { downstreamResultIds } from '../src/index.js';

describe('processor provenance graph', () => {
  it('[ARCH-003][EDIT-001][EDIT-002] traverses exact recorded artifact edges without invalidating siblings or ancestors', () => {
    expect(
      downstreamResultIds(
        ['observation-a'],
        [
          { inputResultId: 'observation-a', outputResultId: 'summary-a' },
          { inputResultId: 'summary-a', outputResultId: 'digest-a' },
          { inputResultId: 'observation-b', outputResultId: 'summary-b' },
        ],
      ),
    ).toEqual(['digest-a', 'summary-a']);
  });

  it('[ARCH-003][EDIT-001][EDIT-002] property: disconnected results are never selected by targeted invalidation', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), {
          minLength: 2,
          maxLength: 24,
        }),
        (ids) => {
          const split = Math.max(1, Math.floor(ids.length / 2));
          const left = ids.slice(0, split);
          const right = ids.slice(split);
          const edges = [left, right].flatMap((partition) =>
            partition.slice(1).map((id, index) => ({
              inputResultId: partition[index] as string,
              outputResultId: id,
            })),
          );
          const selected = downstreamResultIds([left[0] as string], edges);
          expect(selected.every((id) => left.includes(id))).toBe(true);
        },
      ),
    );
  });
});
