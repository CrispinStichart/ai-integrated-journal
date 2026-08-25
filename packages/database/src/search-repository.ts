import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { SearchLayer } from '@journal/contracts';

import type { JournalDatabase } from './client.js';
import { processorInstallations, searchFragments } from './schema.js';

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

const START_MARKER = '\uE000';
const END_MARKER = '\uE001';

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
}
