import { afterEach, describe, expect, it, vi } from 'vitest';

import { lexicalSearch } from '../src/search/api';

const response = {
  items: [
    {
      fragmentId: '019c5b90-0000-7000-8000-000000000041',
      sourceKind: 'transcript_revision',
      layer: 'corrected',
      sourceId: '019c5b90-0000-7000-8000-000000000042',
      sourceRevisionId: '019c5b90-0000-7000-8000-000000000041',
      sourceRevision: 2,
      journalDate: '2026-08-25',
      transcriptId: '019c5b90-0000-7000-8000-000000000042',
      contributionType: 'recording',
      authority: 'manual',
      score: 0.75,
      snippet: [{ text: 'Morning walk', highlighted: true }],
      href: '/journal/2026-08-25?revision=exact',
    },
  ],
  retrieval: { requestedMode: 'hybrid', effectiveMode: 'hybrid' },
  page: { hasMore: true, nextCursor: 'next_cursor' },
};

describe('search API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('[SEARCH-001][SEARCH-005] serializes selected layers and composable filters with an opaque cursor', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(response), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      lexicalSearch(
        {
          q: 'morning',
          mode: 'hybrid',
          layers: ['typed_text', 'corrected'],
          dateFrom: '2026-08-01',
          contributionTypes: ['typed_text', 'recording'],
          authority: 'manual',
          entity: 'Nicolette',
        },
        'next_cursor',
      ),
    ).resolves.toMatchObject({ page: { nextCursor: 'next_cursor' } });
    const url = String(fetch.mock.calls[0]?.[0]);
    expect(url).toContain('layers=typed_text%2Ccorrected');
    expect(url).toContain('contributionTypes=typed_text%2Crecording');
    expect(url).toContain('cursor=next_cursor');
    expect(url).toContain('mode=hybrid');
  });
});
