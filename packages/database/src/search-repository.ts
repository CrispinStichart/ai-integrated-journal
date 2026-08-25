import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { SearchLayer } from '@journal/contracts';

import type { JournalDatabase } from './client.js';
import {
  processorInstallations,
  searchEmbeddingCohorts,
  searchEmbeddingRequests,
  searchFragmentEmbeddings,
  searchFragments,
} from './schema.js';

export interface LexicalSearchCursor {
  readonly score: string;
  readonly journalDate: string | null;
  readonly fragmentId: string;
}

export interface LexicalSearchFilters {
  readonly layers?: readonly SearchLayer[];
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly contributionTypes?: readonly (
    'typed_text' | 'recording' | 'nudge_response'
  )[];
  readonly processorId?: string;
  readonly resultType?: string;
  readonly entity?: string;
  readonly authority?: 'manual' | 'generated';
}

export interface LexicalSearchRow {
  readonly fragmentId: string;
  readonly sourceKind: string;
  readonly layer: string;
  readonly sourceId: string;
  readonly sourceRevisionId: string;
  readonly sourceRevision: number;
  readonly journalDate: string | null;
  readonly contributionId: string | null;
  readonly transcriptId: string | null;
  readonly artifactId: string | null;
  readonly memoryId: string | null;
  readonly processorId: string | null;
  readonly processorVersionId: string | null;
  readonly processorName: string | null;
  readonly contributionType: string | null;
  readonly resultType: string | null;
  readonly authority: 'manual' | 'generated';
  readonly score: string;
  readonly headline: string;
}

export interface SemanticSearchCohort {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelVersion?: string;
  readonly dimension: number;
  readonly configurationFingerprint: string;
}

export interface SemanticSearchRow extends Omit<LexicalSearchRow, 'score'> {
  readonly distance: string;
  readonly chunkIndex: number;
  readonly startCharacter: number;
  readonly endCharacter: number;
}

const START_MARKER = '\uE000';
const END_MARKER = '\uE001';

function cosineDistance(vectorLiteral: string, dimension: number) {
  switch (dimension) {
    case 4:
      return sql<string>`(${searchFragmentEmbeddings.embedding}::vector(4) <=> ${vectorLiteral}::vector(4))`;
    case 384:
      return sql<string>`(${searchFragmentEmbeddings.embedding}::vector(384) <=> ${vectorLiteral}::vector(384))`;
    case 768:
      return sql<string>`(${searchFragmentEmbeddings.embedding}::vector(768) <=> ${vectorLiteral}::vector(768))`;
    case 1024:
      return sql<string>`(${searchFragmentEmbeddings.embedding}::vector(1024) <=> ${vectorLiteral}::vector(1024))`;
    case 1536:
      return sql<string>`(${searchFragmentEmbeddings.embedding}::vector(1536) <=> ${vectorLiteral}::vector(1536))`;
    case 3072:
      return sql<string>`(${searchFragmentEmbeddings.embedding}::halfvec(3072) <=> ${vectorLiteral}::halfvec(3072))`;
    default:
      return sql<string>`${searchFragmentEmbeddings.embedding} <=> ${vectorLiteral}::vector`;
  }
}

/** Owner-scoped PostgreSQL FTS with filters applied before a stable rank cursor. */
export class SearchRepository {
  public constructor(private readonly database: JournalDatabase) {}

  public async lexical(
    input: Readonly<{
      ownerId: string;
      query: string;
      filters: LexicalSearchFilters;
      limit: number;
      cursor?: LexicalSearchCursor;
    }>,
  ): Promise<readonly LexicalSearchRow[]> {
    const query = sql`"journal"."lexical_search_query"(${input.query})`;
    const rank = sql<string>`ts_rank_cd(${searchFragments.searchVector}, ${query}, 32)::numeric`;
    const conditions = [
      eq(searchFragments.ownerId, input.ownerId),
      sql`${searchFragments.searchVector} @@ ${query}`,
    ];
    const { filters } = input;
    if (filters.layers !== undefined)
      conditions.push(inArray(searchFragments.layer, [...filters.layers]));
    if (filters.dateFrom !== undefined)
      conditions.push(
        sql`${searchFragments.journalDate} >= ${filters.dateFrom}`,
      );
    if (filters.dateTo !== undefined)
      conditions.push(sql`${searchFragments.journalDate} <= ${filters.dateTo}`);
    if (filters.contributionTypes !== undefined)
      conditions.push(
        inArray(searchFragments.contributionType, [
          ...filters.contributionTypes,
        ]),
      );
    if (filters.processorId !== undefined)
      conditions.push(eq(searchFragments.processorId, filters.processorId));
    if (filters.resultType !== undefined)
      conditions.push(eq(searchFragments.resultType, filters.resultType));
    if (filters.authority !== undefined)
      conditions.push(eq(searchFragments.authority, filters.authority));
    if (filters.entity !== undefined) {
      const entityQuery = sql`"journal"."lexical_search_query"(${filters.entity})`;
      conditions.push(sql`${searchFragments.searchVector} @@ ${entityQuery}`);
    }
    if (input.cursor !== undefined) {
      const lowerRank = lt(rank, input.cursor.score);
      const sameRank = eq(rank, input.cursor.score);
      const afterTie =
        input.cursor.journalDate === null
          ? and(
              isNull(searchFragments.journalDate),
              sql`${searchFragments.id} > ${input.cursor.fragmentId}`,
            )
          : or(
              lt(searchFragments.journalDate, input.cursor.journalDate),
              isNull(searchFragments.journalDate),
              and(
                eq(searchFragments.journalDate, input.cursor.journalDate),
                sql`${searchFragments.id} > ${input.cursor.fragmentId}`,
              ),
            );
      const afterCursor = or(lowerRank, and(sameRank, afterTie));
      if (afterCursor !== undefined) conditions.push(afterCursor);
    }

    return this.database
      .select({
        fragmentId: searchFragments.id,
        sourceKind: searchFragments.sourceKind,
        layer: searchFragments.layer,
        sourceId: searchFragments.sourceId,
        sourceRevisionId: searchFragments.sourceRevisionId,
        sourceRevision: searchFragments.sourceRevision,
        journalDate: searchFragments.journalDate,
        contributionId: searchFragments.contributionId,
        transcriptId: searchFragments.transcriptId,
        artifactId: searchFragments.artifactId,
        memoryId: searchFragments.memoryId,
        processorId: searchFragments.processorId,
        processorVersionId: searchFragments.processorVersionId,
        processorName: processorInstallations.displayName,
        contributionType: searchFragments.contributionType,
        resultType: searchFragments.resultType,
        authority: searchFragments.authority,
        score: rank,
        headline: sql<string>`ts_headline(
          'english',
          replace(replace(${searchFragments.content}, ${START_MARKER}, ''), ${END_MARKER}, ''),
          ${query},
          ${`StartSel=${START_MARKER}, StopSel=${END_MARKER}, MaxFragments=2, MaxWords=30, MinWords=10, FragmentDelimiter= … `}
        )`,
      })
      .from(searchFragments)
      .leftJoin(
        processorInstallations,
        eq(processorInstallations.id, searchFragments.processorId),
      )
      .where(and(...conditions))
      .orderBy(
        desc(rank),
        desc(searchFragments.journalDate),
        asc(searchFragments.id),
      )
      .limit(input.limit + 1);
  }

  /** Exact-cohort cosine retrieval; the best bounded chunk represents a revision. */
  public async semantic(
    input: Readonly<{
      ownerId: string;
      vector: readonly number[];
      cohort: SemanticSearchCohort;
      filters: LexicalSearchFilters;
      limit: number;
    }>,
  ): Promise<readonly SemanticSearchRow[]> {
    const vectorLiteral = `[${input.vector.join(',')}]`;
    const distance = cosineDistance(vectorLiteral, input.cohort.dimension);
    const conditions = [
      eq(searchFragments.ownerId, input.ownerId),
      eq(searchFragmentEmbeddings.ownerId, input.ownerId),
      eq(searchEmbeddingCohorts.ownerId, input.ownerId),
      eq(searchEmbeddingRequests.ownerId, input.ownerId),
      eq(searchEmbeddingRequests.status, 'succeeded'),
      eq(searchEmbeddingRequests.cohortId, searchEmbeddingCohorts.id),
      eq(searchEmbeddingCohorts.providerId, input.cohort.providerId),
      eq(searchEmbeddingCohorts.modelId, input.cohort.modelId),
      eq(searchEmbeddingCohorts.modelVersion, input.cohort.modelVersion ?? ''),
      eq(searchEmbeddingCohorts.dimension, input.cohort.dimension),
      eq(
        searchEmbeddingCohorts.configurationFingerprint,
        input.cohort.configurationFingerprint,
      ),
    ];
    this.applyFilters(conditions, input.filters);

    const rankedChunks = this.database
      .select({
        fragmentId: searchFragments.id,
        distance: distance.as('distance'),
        chunkIndex: searchFragmentEmbeddings.chunkIndex,
        startCharacter: searchFragmentEmbeddings.startCharacter,
        endCharacter: searchFragmentEmbeddings.endCharacter,
        chunkRank:
          sql<number>`row_number() over (partition by ${searchFragments.id} order by ${distance}, ${searchFragmentEmbeddings.chunkIndex})`.as(
            'chunk_rank',
          ),
      })
      .from(searchFragments)
      .innerJoin(
        searchEmbeddingRequests,
        eq(searchEmbeddingRequests.fragmentId, searchFragments.id),
      )
      .innerJoin(
        searchFragmentEmbeddings,
        and(
          eq(searchFragmentEmbeddings.fragmentId, searchFragments.id),
          eq(
            searchFragmentEmbeddings.cohortId,
            searchEmbeddingRequests.cohortId,
          ),
        ),
      )
      .innerJoin(
        searchEmbeddingCohorts,
        eq(searchEmbeddingCohorts.id, searchFragmentEmbeddings.cohortId),
      )
      .where(and(...conditions))
      .as('ranked_chunks');

    return this.database
      .select({
        fragmentId: searchFragments.id,
        sourceKind: searchFragments.sourceKind,
        layer: searchFragments.layer,
        sourceId: searchFragments.sourceId,
        sourceRevisionId: searchFragments.sourceRevisionId,
        sourceRevision: searchFragments.sourceRevision,
        journalDate: searchFragments.journalDate,
        contributionId: searchFragments.contributionId,
        transcriptId: searchFragments.transcriptId,
        artifactId: searchFragments.artifactId,
        memoryId: searchFragments.memoryId,
        processorId: searchFragments.processorId,
        processorVersionId: searchFragments.processorVersionId,
        processorName: processorInstallations.displayName,
        contributionType: searchFragments.contributionType,
        resultType: searchFragments.resultType,
        authority: searchFragments.authority,
        distance: rankedChunks.distance,
        chunkIndex: rankedChunks.chunkIndex,
        startCharacter: rankedChunks.startCharacter,
        endCharacter: rankedChunks.endCharacter,
        headline: sql<string>`substring(
          ${searchFragments.content}
          from greatest(1, ${rankedChunks.startCharacter} - 80)
          for least(400, ${rankedChunks.endCharacter} - ${rankedChunks.startCharacter} + 161)
        )`,
      })
      .from(rankedChunks)
      .innerJoin(
        searchFragments,
        eq(searchFragments.id, rankedChunks.fragmentId),
      )
      .leftJoin(
        processorInstallations,
        eq(processorInstallations.id, searchFragments.processorId),
      )
      .where(eq(rankedChunks.chunkRank, 1))
      .orderBy(
        asc(rankedChunks.distance),
        desc(searchFragments.journalDate),
        asc(searchFragments.id),
      )
      .limit(input.limit);
  }

  public async hasSearchableCohort(
    ownerId: string,
    cohort: SemanticSearchCohort,
  ): Promise<boolean> {
    const rows = await this.database
      .select({ fragmentId: searchEmbeddingRequests.fragmentId })
      .from(searchEmbeddingRequests)
      .innerJoin(
        searchEmbeddingCohorts,
        eq(searchEmbeddingCohorts.id, searchEmbeddingRequests.cohortId),
      )
      .where(
        and(
          eq(searchEmbeddingRequests.ownerId, ownerId),
          eq(searchEmbeddingRequests.status, 'succeeded'),
          eq(searchEmbeddingCohorts.ownerId, ownerId),
          eq(searchEmbeddingCohorts.providerId, cohort.providerId),
          eq(searchEmbeddingCohorts.modelId, cohort.modelId),
          eq(searchEmbeddingCohorts.modelVersion, cohort.modelVersion ?? ''),
          eq(searchEmbeddingCohorts.dimension, cohort.dimension),
          eq(
            searchEmbeddingCohorts.configurationFingerprint,
            cohort.configurationFingerprint,
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private applyFilters(
    conditions: ReturnType<typeof eq>[],
    filters: LexicalSearchFilters,
  ): void {
    if (filters.layers !== undefined)
      conditions.push(inArray(searchFragments.layer, [...filters.layers]));
    if (filters.dateFrom !== undefined)
      conditions.push(
        sql`${searchFragments.journalDate} >= ${filters.dateFrom}`,
      );
    if (filters.dateTo !== undefined)
      conditions.push(sql`${searchFragments.journalDate} <= ${filters.dateTo}`);
    if (filters.contributionTypes !== undefined)
      conditions.push(
        inArray(searchFragments.contributionType, [
          ...filters.contributionTypes,
        ]),
      );
    if (filters.processorId !== undefined)
      conditions.push(eq(searchFragments.processorId, filters.processorId));
    if (filters.resultType !== undefined)
      conditions.push(eq(searchFragments.resultType, filters.resultType));
    if (filters.authority !== undefined)
      conditions.push(eq(searchFragments.authority, filters.authority));
    if (filters.entity !== undefined) {
      const entityQuery = sql`"journal"."lexical_search_query"(${filters.entity})`;
      conditions.push(sql`${searchFragments.searchVector} @@ ${entityQuery}`);
    }
  }
}
