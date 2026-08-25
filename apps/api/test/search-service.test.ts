import type { JournalDatabase, LexicalSearchRow } from '@journal/database';
import { describe, expect, it, vi } from 'vitest';

import {
  PostgresSearchService,
  SearchCursorError,
} from '../src/search-service.js';

const row = (id: string, date: string): LexicalSearchRow => ({
  fragmentId: id,
  sourceKind: 'contribution_revision',
  layer: 'typed_text',
  sourceId: '019c5b90-0000-7000-8000-000000000042',
  sourceRevisionId: id,
  sourceRevision: 2,
  journalDate: date,
  contributionId: '019c5b90-0000-7000-8000-000000000042',
  transcriptId: null,
  artifactId: null,
  memoryId: null,
  processorId: null,
  processorVersionId: null,
  processorName: null,
  contributionType: 'typed_text',
  resultType: null,
  authority: 'manual',
  score: '0.75',
  headline: 'Before \uE000<img onerror=alert(1)>\uE001 after',
});

describe('search service pagination and mapping', () => {
  it('[SEARCH-001][SEARCH-003][SEARCH-004] binds opaque cursors to filters and maps inert exact-source results', async () => {
    const lexical = vi
      .fn()
      .mockResolvedValueOnce([
        row('019c5b90-0000-7000-8000-000000000041', '2026-08-25'),
        row('019c5b90-0000-7000-8000-000000000043', '2026-08-24'),
      ])
      .mockResolvedValueOnce([]);
    const service = new PostgresSearchService({} as JournalDatabase, {
      lexical,
    });
    const first = await service.lexical('owner', {
      q: 'morning',
      layers: ['typed_text'],
      limit: 1,
    });
    expect(first.items[0]).toMatchObject({
      score: 0.75,
      snippet: [
        { text: 'Before ', highlighted: false },
        { text: '<img onerror=alert(1)>', highlighted: true },
        { text: ' after', highlighted: false },
      ],
    });
    expect(first.nextCursor).toBeDefined();
    await service.lexical('owner', {
      q: 'morning',
      layers: ['typed_text'],
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(lexical).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: expect.objectContaining({
          score: '0.75',
          journalDate: '2026-08-25',
        }),
      }),
    );
    await expect(
      service.lexical('owner', {
        q: 'different',
        layers: ['typed_text'],
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(SearchCursorError);
  });
});
