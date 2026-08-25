import type {
  JournalDatabase,
  LexicalSearchRow,
  SearchRepository,
  SemanticSearchRow,
} from '@journal/database';
import { describe, expect, it, vi } from 'vitest';

import {
  PostgresSearchService,
  SearchCursorError,
} from '../src/search-service.js';

const CONFIGURATION_FINGERPRINT = 'a'.repeat(64);

const row = (id: string, date: string, score = '0.75'): LexicalSearchRow => ({
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
  score,
  headline: 'Before \uE000<img onerror=alert(1)>\uE001 after',
});

function semanticRow(
  id: string,
  date: string,
  distance: string,
): SemanticSearchRow {
  const lexical: Partial<LexicalSearchRow> = { ...row(id, date) };
  Reflect.deleteProperty(lexical, 'score');
  return {
    ...(lexical as Omit<LexicalSearchRow, 'score'>),
    distance,
    chunkIndex: 0,
    startCharacter: 1,
    endCharacter: 20,
    headline: 'Semantically similar safe excerpt',
  };
}

function repository(overrides: Partial<SearchRepository> = {}) {
  return {
    lexical: vi.fn(async () => []),
    semantic: vi.fn(async () => []),
    hasSearchableCohort: vi.fn(async () => true),
    ...overrides,
  } as unknown as Pick<
    SearchRepository,
    'lexical' | 'semantic' | 'hasSearchableCohort'
  >;
}

const availableProvider = () =>
  Promise.resolve({
    status: 'available' as const,
    port: {
      embed: vi.fn(async () => ({
        embeddings: [{ fragmentId: 'query', vector: [1, 0, 0, 0] }],
        dimension: 4,
        usage: { status: 'unknown' as const },
        operation: {
          provider: { id: 'fixture', displayName: 'Fixture' },
          model: { id: 'semantic-v1', version: '1' },
          configuration: {
            parameters: {},
            fingerprint: CONFIGURATION_FINGERPRINT,
          },
          processingTimeMs: 1,
        },
        rawResponse: {
          body: new Uint8Array(),
          mediaType: 'application/json',
        },
      })),
    },
  });

describe('search service pagination, fallback, and fusion', () => {
  it('[SEARCH-001][SEARCH-003][SEARCH-004] binds lexical cursors to filters and maps inert exact-source results', async () => {
    const lexical = vi
      .fn()
      .mockResolvedValueOnce([
        row('019c5b90-0000-7000-8000-000000000041', '2026-08-25'),
        row('019c5b90-0000-7000-8000-000000000043', '2026-08-24'),
      ])
      .mockResolvedValueOnce([]);
    const service = new PostgresSearchService(
      {} as JournalDatabase,
      repository({ lexical } as Partial<SearchRepository>),
    );
    const first = await service.search('owner', {
      q: 'morning',
      mode: 'lexical',
      layers: ['typed_text'],
      limit: 1,
    });
    expect(first).toMatchObject({
      retrieval: { requestedMode: 'lexical', effectiveMode: 'lexical' },
      items: [
        {
          score: 0.75,
          snippet: [
            { text: 'Before ', highlighted: false },
            { text: '<img onerror=alert(1)>', highlighted: true },
            { text: ' after', highlighted: false },
          ],
        },
      ],
    });
    expect(first.nextCursor).toBeDefined();
    await service.search('owner', {
      q: 'morning',
      mode: 'lexical',
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
      service.search('owner', {
        q: 'different',
        mode: 'lexical',
        layers: ['typed_text'],
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(SearchCursorError);
  });

  it('[SEARCH-002][SEARCH-005][MODEL-003] retrieves only the exact provider/model/version/configuration/dimension cohort', async () => {
    const semantic = vi.fn(async () => [
      semanticRow('019c5b90-0000-7000-8000-000000000051', '2026-08-25', '0.1'),
    ]);
    const service = new PostgresSearchService(
      {} as JournalDatabase,
      repository({ semantic } as Partial<SearchRepository>),
      availableProvider,
    );
    const result = await service.search('owner', {
      q: 'a similar morning',
      mode: 'semantic',
      authority: 'manual',
      limit: 20,
    });
    expect(semantic).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner',
        cohort: {
          providerId: 'fixture',
          modelId: 'semantic-v1',
          modelVersion: '1',
          dimension: 4,
          configurationFingerprint: CONFIGURATION_FINGERPRINT,
        },
        filters: { authority: 'manual' },
      }),
    );
    expect(result).toMatchObject({
      retrieval: {
        requestedMode: 'semantic',
        effectiveMode: 'semantic',
        cohort: { dimension: 4 },
      },
      items: [
        {
          retrievalSignals: { semanticRank: 1 },
          snippet: [{ highlighted: false }],
        },
      ],
    });
  });

  it('[SEARCH-002][SEARCH-005] applies deterministic reciprocal-rank fusion and retains exact revision links', async () => {
    const lexicalRows = [
      row('019c5b90-0000-7000-8000-000000000061', '2026-08-24'),
      row('019c5b90-0000-7000-8000-000000000062', '2026-08-25'),
    ];
    const semanticRows = [
      semanticRow('019c5b90-0000-7000-8000-000000000062', '2026-08-25', '0.1'),
      semanticRow('019c5b90-0000-7000-8000-000000000063', '2026-08-23', '0.2'),
    ];
    const service = new PostgresSearchService(
      {} as JournalDatabase,
      repository({
        lexical: vi.fn(async () => lexicalRows),
        semantic: vi.fn(async () => semanticRows),
      } as Partial<SearchRepository>),
      availableProvider,
    );
    const result = await service.search('owner', {
      q: 'morning',
      mode: 'hybrid',
      limit: 20,
    });
    expect(result.items.map(({ fragmentId }) => fragmentId)).toEqual([
      '019c5b90-0000-7000-8000-000000000062',
      '019c5b90-0000-7000-8000-000000000061',
      '019c5b90-0000-7000-8000-000000000063',
    ]);
    expect(result.items[0]).toMatchObject({
      retrievalSignals: { lexicalRank: 2, semanticRank: 1 },
      href: expect.stringContaining('revision='),
    });
  });

  it.each([
    {
      name: 'capability absence',
      resolver: async () => ({
        status: 'unavailable' as const,
        providerId: 'none',
        capability: 'embeddings' as const,
        reason: 'provider_not_registered' as const,
      }),
      hasCohort: true,
      reason: 'provider_unavailable',
    },
    {
      name: 'provider failure',
      resolver: async () => {
        throw new Error('synthetic provider outage');
      },
      hasCohort: true,
      reason: 'provider_failed',
    },
    {
      name: 'cohort not indexed',
      resolver: availableProvider,
      hasCohort: false,
      reason: 'semantic_index_unavailable',
    },
  ])(
    '[ARCH-005][SEARCH-002][SEARCH-006] falls back to lexical for $name',
    async (fixture) => {
      const lexical = vi.fn(async () => [
        row('019c5b90-0000-7000-8000-000000000071', '2026-08-25'),
      ]);
      const service = new PostgresSearchService(
        {} as JournalDatabase,
        repository({
          lexical,
          hasSearchableCohort: vi.fn(async () => fixture.hasCohort),
        } as Partial<SearchRepository>),
        fixture.resolver,
      );
      const result = await service.search('owner', {
        q: 'morning',
        mode: 'hybrid',
        limit: 20,
      });
      expect(result.retrieval).toEqual({
        requestedMode: 'hybrid',
        effectiveMode: 'lexical',
        fallbackReason: fixture.reason,
      });
      expect(result.items).toHaveLength(1);
      expect(lexical).toHaveBeenCalled();
    },
  );
});
