import { describe, expect, it } from 'vitest';

import {
  lexicalSearchPageSchema,
  lexicalSearchRequestSchema,
} from '../src/index.js';

describe('lexical search contracts', () => {
  it('[SEARCH-001][SEARCH-005] parses composable layer and lifecycle filters', () => {
    expect(
      lexicalSearchRequestSchema.parse({
        q: ' morning walk ',
        layers: 'typed_text,corrected,observation',
        contributionTypes: 'typed_text,recording',
        dateFrom: '2026-08-01',
        dateTo: '2026-08-25',
        authority: 'manual',
      }),
    ).toMatchObject({
      q: 'morning walk',
      layers: ['typed_text', 'corrected', 'observation'],
      contributionTypes: ['typed_text', 'recording'],
      limit: 20,
    });
    expect(
      lexicalSearchRequestSchema.safeParse({
        q: 'walk',
        dateFrom: '2026-08-25',
        dateTo: '2026-08-01',
      }).success,
    ).toBe(false);
  });

  it('[SEARCH-003][SEARCH-004] carries precise revision links and text-only snippet segments', () => {
    expect(
      lexicalSearchPageSchema.parse({
        items: [
          {
            fragmentId: '019c5b90-0000-7000-8000-000000000041',
            sourceKind: 'contribution_revision',
            layer: 'typed_text',
            sourceId: '019c5b90-0000-7000-8000-000000000042',
            sourceRevisionId: '019c5b90-0000-7000-8000-000000000041',
            sourceRevision: 2,
            journalDate: '2026-08-25',
            contributionId: '019c5b90-0000-7000-8000-000000000042',
            contributionType: 'typed_text',
            authority: 'manual',
            score: 0.5,
            snippet: [
              { text: '<img src=x onerror=alert(1)>', highlighted: true },
            ],
            href: '/journal/2026-08-25?revision=exact',
          },
        ],
        page: { hasMore: false },
      }).items[0]?.snippet[0]?.text,
    ).toBe('<img src=x onerror=alert(1)>');
  });
});
