import { describe, expect, it } from 'vitest';

import { parseSearchHeadline, searchResultHref } from '../src/index.js';

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
