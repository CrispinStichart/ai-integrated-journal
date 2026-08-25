import { createHash } from 'node:crypto';

import type {
  LexicalSearchRequest,
  LexicalSearchResult,
} from '@journal/contracts';
import { SearchRepository, type JournalDatabase } from '@journal/database';
import { parseSearchHeadline, searchResultHref } from '@journal/domain';
import { z } from 'zod';

const cursorPayloadSchema = z.strictObject({
  version: z.literal(1),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  score: z.string().regex(/^\d+(?:\.\d+)?$/),
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

export interface SearchService {
  lexical(
    ownerId: string,
    request: LexicalSearchRequest,
  ): Promise<
    Readonly<{ items: readonly LexicalSearchResult[]; nextCursor?: string }>
  >;
}

function fingerprint(request: LexicalSearchRequest): string {
  const canonical = {
    q: request.q,
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
  return Buffer.from(JSON.stringify({ version: 1, ...value })).toString(
    'base64url',
  );
}

export class PostgresSearchService implements SearchService {
  private readonly repository: Pick<SearchRepository, 'lexical'>;

  public constructor(
    database: JournalDatabase,
    repository: Pick<SearchRepository, 'lexical'> = new SearchRepository(
      database,
    ),
  ) {
    this.repository = repository;
  }

  public async lexical(ownerId: string, request: LexicalSearchRequest) {
    const queryFingerprint = fingerprint(request);
    const cursor =
      request.cursor === undefined
        ? undefined
        : decodeCursor(request.cursor, queryFingerprint);
    const rows = await this.repository.lexical({
      ownerId,
      query: request.q,
      filters: {
        ...(request.layers === undefined ? {} : { layers: request.layers }),
        ...(request.dateFrom === undefined
          ? {}
          : { dateFrom: request.dateFrom }),
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
      },
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
    const items: LexicalSearchResult[] = visible.map((row) => ({
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
      ...(row.processorName === null
        ? {}
        : { processorName: row.processorName }),
      ...(row.contributionType === null
        ? {}
        : {
            contributionType:
              row.contributionType as LexicalSearchResult['contributionType'],
          }),
      ...(row.resultType === null ? {} : { resultType: row.resultType }),
      authority: row.authority,
      score: Number(row.score),
      snippet: [...parseSearchHeadline(row.headline)],
      href: searchResultHref({
        ...(row.journalDate === null ? {} : { journalDate: row.journalDate }),
        sourceRevisionId: row.sourceRevisionId,
        sourceKind: row.sourceKind,
        ...(row.memoryId === null ? {} : { memoryId: row.memoryId }),
      }),
    }));
    const last = visible.at(-1);
    return {
      items,
      ...(rows.length <= request.limit || last === undefined
        ? {}
        : {
            nextCursor: encodeCursor({
              fingerprint: queryFingerprint,
              score: last.score,
              journalDate: last.journalDate,
              fragmentId: last.fragmentId,
            }),
          }),
    };
  }
}
