import { createHash } from 'node:crypto';

import {
  SEMANTIC_SEARCH_EMBEDDING_CONFIGURATION,
  type CapabilityResolution,
  type EmbeddingProvider,
} from '@journal/ai';
import type {
  LexicalSearchRequest,
  LexicalSearchResult,
  SearchFallbackReason,
  SearchMode,
  SearchRetrievalMetadata,
} from '@journal/contracts';
import {
  SearchRepository,
  type JournalDatabase,
  type LexicalSearchFilters,
  type LexicalSearchRow,
  type SemanticSearchCohort,
  type SemanticSearchRow,
} from '@journal/database';
import {
  MAX_RETRIEVAL_CANDIDATES,
  embeddingCohortKey,
  parseSearchHeadline,
  reciprocalRankFusion,
  searchResultHref,
  validateEmbeddingVector,
} from '@journal/domain';
import { z } from 'zod';

const cursorPayloadSchema = z.strictObject({
  version: z.literal(2),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  mode: z.enum(['lexical', 'semantic', 'hybrid']),
  score: z.string().regex(/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i),
  journalDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  fragmentId: z.uuid(),
});

export class SearchCursorError extends Error {
  public constructor() {
    super('The search cursor is invalid or belongs to different filters.');
    this.name = 'SearchCursorError';
  }
}

export type SearchEmbeddingProviderResolver = () => Promise<
  CapabilityResolution<EmbeddingProvider>
>;

export interface SearchService {
  search(
    ownerId: string,
    request: LexicalSearchRequest,
  ): Promise<
    Readonly<{
      items: readonly LexicalSearchResult[];
      retrieval: SearchRetrievalMetadata;
      nextCursor?: string;
    }>
  >;
}

function fingerprint(request: LexicalSearchRequest): string {
  const canonical = {
    q: request.q,
    mode: request.mode ?? 'lexical',
    layers: request.layers ?? null,
    dateFrom: request.dateFrom ?? null,
    dateTo: request.dateTo ?? null,
    contributionTypes: request.contributionTypes ?? null,
    processorId: request.processorId ?? null,
    resultType: request.resultType ?? null,
    entity: request.entity ?? null,
    authority: request.authority ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function decodeCursor(cursor: string, expectedFingerprint: string) {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    const parsed = cursorPayloadSchema.parse(value);
    if (parsed.fingerprint !== expectedFingerprint)
      throw new SearchCursorError();
    return parsed;
  } catch (error) {
    if (error instanceof SearchCursorError) throw error;
    throw new SearchCursorError();
  }
}

function encodeCursor(
  value: Omit<z.infer<typeof cursorPayloadSchema>, 'version'>,
): string {
  return Buffer.from(JSON.stringify({ version: 2, ...value })).toString(
    'base64url',
  );
}

function requestFilters(request: LexicalSearchRequest): LexicalSearchFilters {
  return {
    ...(request.layers === undefined ? {} : { layers: request.layers }),
    ...(request.dateFrom === undefined ? {} : { dateFrom: request.dateFrom }),
    ...(request.dateTo === undefined ? {} : { dateTo: request.dateTo }),
    ...(request.contributionTypes === undefined
      ? {}
      : { contributionTypes: request.contributionTypes }),
    ...(request.processorId === undefined
      ? {}
      : { processorId: request.processorId }),
    ...(request.resultType === undefined
      ? {}
      : { resultType: request.resultType }),
    ...(request.entity === undefined ? {} : { entity: request.entity }),
    ...(request.authority === undefined
      ? {}
      : { authority: request.authority }),
  };
}

function commonResult(
  row: Omit<LexicalSearchRow, 'score' | 'headline'>,
): Omit<LexicalSearchResult, 'score' | 'snippet'> {
  return {
    fragmentId: row.fragmentId,
    sourceKind: row.sourceKind as LexicalSearchResult['sourceKind'],
    layer: row.layer as LexicalSearchResult['layer'],
    sourceId: row.sourceId,
    sourceRevisionId: row.sourceRevisionId,
    sourceRevision: row.sourceRevision,
    ...(row.journalDate === null ? {} : { journalDate: row.journalDate }),
    ...(row.contributionId === null
      ? {}
      : { contributionId: row.contributionId }),
    ...(row.transcriptId === null ? {} : { transcriptId: row.transcriptId }),
    ...(row.artifactId === null ? {} : { artifactId: row.artifactId }),
    ...(row.memoryId === null ? {} : { memoryId: row.memoryId }),
    ...(row.processorId === null ? {} : { processorId: row.processorId }),
    ...(row.processorVersionId === null
      ? {}
      : { processorVersionId: row.processorVersionId }),
    ...(row.processorName === null ? {} : { processorName: row.processorName }),
    ...(row.contributionType === null
      ? {}
      : {
          contributionType:
            row.contributionType as LexicalSearchResult['contributionType'],
        }),
    ...(row.resultType === null ? {} : { resultType: row.resultType }),
    authority: row.authority,
    href: searchResultHref({
      ...(row.journalDate === null ? {} : { journalDate: row.journalDate }),
      sourceRevisionId: row.sourceRevisionId,
      sourceKind: row.sourceKind,
      ...(row.memoryId === null ? {} : { memoryId: row.memoryId }),
    }),
  };
}

function lexicalResult(
  row: LexicalSearchRow,
  lexicalRank?: number,
): LexicalSearchResult {
  return {
    ...commonResult(row),
    score: Number(row.score),
    snippet: [...parseSearchHeadline(row.headline)],
    ...(lexicalRank === undefined ? {} : { retrievalSignals: { lexicalRank } }),
  };
}

function semanticResult(
  row: SemanticSearchRow,
  semanticRank: number,
): LexicalSearchResult {
  const distance = Number(row.distance);
  const score = Number.isFinite(distance) ? Math.max(0, 1 / (1 + distance)) : 0;
  return {
    ...commonResult(row),
    score,
    snippet: [{ text: row.headline, highlighted: false }],
    retrievalSignals: { semanticRank },
  };
}

function compareRanked(
  left: LexicalSearchResult,
  right: LexicalSearchResult,
): number {
  return (
    right.score - left.score ||
    (right.journalDate ?? '').localeCompare(left.journalDate ?? '') ||
    left.fragmentId.localeCompare(right.fragmentId)
  );
}

function afterCursor(
  item: LexicalSearchResult,
  cursor: z.infer<typeof cursorPayloadSchema>,
): boolean {
  const score = Number(cursor.score);
  if (item.score !== score) return item.score < score;
  if ((item.journalDate ?? null) !== cursor.journalDate) {
    if (item.journalDate === undefined) return true;
    if (cursor.journalDate === null) return false;
    return item.journalDate < cursor.journalDate;
  }
  return item.fragmentId > cursor.fragmentId;
}

export class PostgresSearchService implements SearchService {
  private readonly repository: Pick<
    SearchRepository,
    'lexical' | 'semantic' | 'hasSearchableCohort'
  >;
  private readonly resolveEmbeddingProvider:
    SearchEmbeddingProviderResolver | undefined;

  public constructor(
    database: JournalDatabase,
    repository: Pick<
      SearchRepository,
      'lexical' | 'semantic' | 'hasSearchableCohort'
    > = new SearchRepository(database),
    resolveEmbeddingProvider?: SearchEmbeddingProviderResolver,
  ) {
    this.repository = repository;
    this.resolveEmbeddingProvider = resolveEmbeddingProvider;
  }

  public async search(ownerId: string, request: LexicalSearchRequest) {
    const requestedMode = request.mode ?? 'lexical';
    const queryFingerprint = fingerprint(request);
    const cursor =
      request.cursor === undefined
        ? undefined
        : decodeCursor(request.cursor, queryFingerprint);
    if (cursor !== undefined && cursor.mode !== requestedMode) {
      throw new SearchCursorError();
    }
    if (requestedMode === 'lexical') {
      return this.lexicalPage(ownerId, request, queryFingerprint, cursor, {
        requestedMode,
        effectiveMode: 'lexical',
      });
    }

    let semantic:
      | Readonly<{
          rows: readonly SemanticSearchRow[];
          cohort: SemanticSearchCohort;
        }>
      | undefined;
    let fallbackReason: SearchFallbackReason | undefined;
    try {
      const resolution = await this.resolveEmbeddingProvider?.();
      if (resolution === undefined || resolution.status === 'unavailable') {
        fallbackReason = 'provider_unavailable';
      } else {
        const result = await resolution.port.embed({
          fragments: [{ id: 'query', text: request.q }],
          configuration: SEMANTIC_SEARCH_EMBEDDING_CONFIGURATION,
        });
        const queryEmbedding = result.embeddings[0];
        if (
          result.embeddings.length !== 1 ||
          queryEmbedding?.fragmentId !== 'query'
        ) {
          throw new Error(
            'Embedding provider returned a mismatched query vector.',
          );
        }
        const vector = validateEmbeddingVector(
          queryEmbedding.vector,
          result.dimension,
        );
        const cohort: SemanticSearchCohort = {
          providerId: result.operation.provider.id,
          modelId: result.operation.model.id,
          ...(result.operation.model.version === undefined
            ? {}
            : { modelVersion: result.operation.model.version }),
          dimension: result.dimension,
          configurationFingerprint: result.operation.configuration.fingerprint,
        };
        embeddingCohortKey(cohort);
        if (!(await this.repository.hasSearchableCohort(ownerId, cohort))) {
          fallbackReason = 'semantic_index_unavailable';
        } else {
          semantic = {
            cohort,
            rows: await this.repository.semantic({
              ownerId,
              vector,
              cohort,
              filters: requestFilters(request),
              limit: MAX_RETRIEVAL_CANDIDATES,
            }),
          };
        }
      }
    } catch {
      fallbackReason = 'provider_failed';
    }

    if (semantic === undefined) {
      return this.lexicalPage(ownerId, request, queryFingerprint, cursor, {
        requestedMode,
        effectiveMode: 'lexical',
        ...(fallbackReason === undefined ? {} : { fallbackReason }),
      });
    }
    const cohortMetadata: SearchRetrievalMetadata['cohort'] = {
      ...semantic.cohort,
    };
    if (requestedMode === 'semantic') {
      const ranked = semantic.rows
        .map((row, index) => semanticResult(row, index + 1))
        .sort(compareRanked);
      return this.rankedPage(
        ranked,
        request.limit,
        queryFingerprint,
        cursor,
        'semantic',
        {
          requestedMode,
          effectiveMode: 'semantic',
          cohort: cohortMetadata,
        },
      );
    }

    const lexicalRows = await this.repository.lexical({
      ownerId,
      query: request.q,
      filters: requestFilters(request),
      limit: MAX_RETRIEVAL_CANDIDATES,
    });
    const lexicalById = new Map(
      lexicalRows
        .slice(0, MAX_RETRIEVAL_CANDIDATES)
        .map((row) => [row.fragmentId, row]),
    );
    const semanticById = new Map(
      semantic.rows.map((row) => [row.fragmentId, row]),
    );
    const fusion = reciprocalRankFusion(
      [...lexicalById.keys()],
      [...semanticById.keys()],
    );
    const ranked = fusion
      .map((rank) => {
        const lexicalRow = lexicalById.get(rank.fragmentId);
        const semanticRow = semanticById.get(rank.fragmentId);
        const base =
          lexicalRow === undefined
            ? semanticResult(
                semanticRow as SemanticSearchRow,
                rank.semanticRank ?? 1,
              )
            : lexicalResult(lexicalRow);
        return {
          ...base,
          score: rank.score,
          retrievalSignals: {
            ...(rank.lexicalRank === undefined
              ? {}
              : { lexicalRank: rank.lexicalRank }),
            ...(rank.semanticRank === undefined
              ? {}
              : { semanticRank: rank.semanticRank }),
          },
        };
      })
      .sort(compareRanked);
    return this.rankedPage(
      ranked,
      request.limit,
      queryFingerprint,
      cursor,
      'hybrid',
      {
        requestedMode,
        effectiveMode: 'hybrid',
        cohort: cohortMetadata,
      },
    );
  }

  private async lexicalPage(
    ownerId: string,
    request: LexicalSearchRequest,
    queryFingerprint: string,
    cursor: z.infer<typeof cursorPayloadSchema> | undefined,
    retrieval: SearchRetrievalMetadata,
  ) {
    const rows = await this.repository.lexical({
      ownerId,
      query: request.q,
      filters: requestFilters(request),
      limit: request.limit,
      ...(cursor === undefined
        ? {}
        : {
            cursor: {
              score: cursor.score,
              journalDate: cursor.journalDate,
              fragmentId: cursor.fragmentId,
            },
          }),
    });
    const visible = rows.slice(0, request.limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => lexicalResult(row)),
      retrieval,
      ...(rows.length <= request.limit || last === undefined
        ? {}
        : {
            nextCursor: encodeCursor({
              fingerprint: queryFingerprint,
              mode: request.mode ?? 'lexical',
              score: last.score,
              journalDate: last.journalDate,
              fragmentId: last.fragmentId,
            }),
          }),
    };
  }

  private rankedPage(
    ranked: readonly LexicalSearchResult[],
    limit: number,
    queryFingerprint: string,
    cursor: z.infer<typeof cursorPayloadSchema> | undefined,
    mode: Exclude<SearchMode, 'lexical'>,
    retrieval: SearchRetrievalMetadata,
  ) {
    const after =
      cursor === undefined
        ? ranked
        : ranked.filter((item) => afterCursor(item, cursor));
    const visible = after.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible,
      retrieval,
      ...(after.length <= limit || last === undefined
        ? {}
        : {
            nextCursor: encodeCursor({
              fingerprint: queryFingerprint,
              mode,
              score: String(last.score),
              journalDate: last.journalDate ?? null,
              fragmentId: last.fragmentId,
            }),
          }),
    };
  }
}
