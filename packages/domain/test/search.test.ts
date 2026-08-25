import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  embeddingCohortKey,
  parseSearchHeadline,
  reciprocalRankFusion,
  searchResultHref,
  validateEmbeddingVector,
} from '../src/index.js';

describe('lexical search presentation', () => {
  it('[SEARCH-003][SEARCH-004] preserves exact source navigation and inert highlighted text', () => {
    expect(
      parseSearchHeadline('Before \uE000<script>alert(1)</script>\uE001 after'),
    ).toEqual([
      { text: 'Before ', highlighted: false },
      { text: '<script>alert(1)</script>', highlighted: true },
      { text: ' after', highlighted: false },
    ]);
    expect(
      searchResultHref({
        journalDate: '2026-08-25',
        sourceKind: 'transcript_revision',
        sourceRevisionId: '019c5b90-0000-7000-8000-000000000044',
      }),
    ).toBe(
      '/journal/2026-08-25?source=transcript_revision&revision=019c5b90-0000-7000-8000-000000000044',
    );
  });

  it('[SEARCH-003] links owner-approved memories to the supporting memory record', () => {
    expect(
      searchResultHref({
        sourceKind: 'memory_revision',
        sourceRevisionId: '019c5b90-0000-7000-8000-000000000045',
        memoryId: '019c5b90-0000-7000-8000-000000000046',
      }),
    ).toBe('/memories?memory=019c5b90-0000-7000-8000-000000000046');
  });
});

describe('semantic and hybrid ranking policy', () => {
  it('[SEARCH-002][SEARCH-005] rewards agreement across lexical and semantic ranks without duplicating fragments', () => {
    expect(
      reciprocalRankFusion(['lexical', 'both'], ['both', 'semantic']),
    ).toEqual([
      {
        fragmentId: 'both',
        score: 1 / 62 + 1 / 61,
        lexicalRank: 2,
        semanticRank: 1,
      },
      {
        fragmentId: 'lexical',
        score: 1 / 61,
        lexicalRank: 1,
      },
      {
        fragmentId: 'semantic',
        score: 1 / 62,
        semanticRank: 2,
      },
    ]);
    expect(reciprocalRankFusion(['same', 'same'], ['same'])).toHaveLength(1);
    expect(() => reciprocalRankFusion([], [], 0)).toThrow(RangeError);
  });

  it('[SEARCH-002][MODEL-003] creates deterministic exact cohort keys and rejects incompatible vector metadata', () => {
    const cohort = {
      providerId: 'fixture',
      modelId: 'semantic-v1',
      modelVersion: '2026-08',
      dimension: 4,
      configurationFingerprint: 'a'.repeat(64),
    };
    expect(embeddingCohortKey(cohort)).toBe(embeddingCohortKey({ ...cohort }));
    expect(validateEmbeddingVector([0, 1, -1, 0.5], 4)).toEqual([
      0, 1, -1, 0.5,
    ]);
    expect(() => validateEmbeddingVector([0, Number.NaN], 2)).toThrow('finite');
    expect(() => validateEmbeddingVector([0], 2)).toThrow('dimension');
    expect(() =>
      embeddingCohortKey({ ...cohort, configurationFingerprint: 'not-a-hash' }),
    ).toThrow('SHA-256');
    expect(() => embeddingCohortKey({ ...cohort, providerId: '' })).toThrow(
      'provider',
    );
  });

  it('[SEARCH-002] preserves deterministic RRF ordering for arbitrary bounded rankings', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
          maxLength: 30,
        }),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
          maxLength: 30,
        }),
        (lexical, semantic) => {
          const first = reciprocalRankFusion(lexical, semantic);
          const second = reciprocalRankFusion(lexical, semantic);
          expect(second).toEqual(first);
          expect(new Set(first.map(({ fragmentId }) => fragmentId)).size).toBe(
            first.length,
          );
          expect(first.every(({ score }) => score > 0)).toBe(true);
        },
      ),
    );
  });
});
