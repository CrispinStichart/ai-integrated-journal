import { createHash } from 'node:crypto';

import type {
  GroundedAnswer,
  GroundedAnswerRequest,
  LexicalSearchRequest,
} from '@journal/contracts';
import {
  GroundedAnswerIdempotencyConflictError,
  GroundedAnswerRepository,
  type GroundedAnswerRecord,
  type JournalDatabase,
} from '@journal/database';
import type { PgBoss } from 'pg-boss';

import type { SearchService } from './search-service.js';

export { GroundedAnswerIdempotencyConflictError };

export class GroundedAnswerNotFoundError extends Error {
  public constructor() {
    super('Grounded answer was not found.');
    this.name = 'GroundedAnswerNotFoundError';
  }
}

export interface GroundedAnswerService {
  ask(
    ownerId: string,
    request: GroundedAnswerRequest,
    idempotencyKey: string,
  ): Promise<GroundedAnswer>;
  get(ownerId: string, answerId: string): Promise<GroundedAnswer>;
}

function requestHash(request: GroundedAnswerRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function searchRequest(request: GroundedAnswerRequest): LexicalSearchRequest {
  return {
    q: request.question,
    mode: request.mode,
    limit: 8,
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

function response(record: GroundedAnswerRecord): GroundedAnswer {
  const sourcesRemainCurrent = record.allCitationsCurrent;
  const status =
    !sourcesRemainCurrent && record.status === 'succeeded'
      ? ('insufficient_support' as const)
      : record.status;
  const cited = record.citations
    .filter(({ citedOrdinal }) => citedOrdinal !== null)
    .sort(
      (left, right) =>
        (left.citedOrdinal as number) - (right.citedOrdinal as number),
    );
  const lineageAvailable =
    sourcesRemainCurrent &&
    record.effectiveMessagesHash !== null &&
    record.provider !== null &&
    record.model !== null &&
    record.effectiveConfiguration !== null &&
    record.usage !== null &&
    record.processingTimeMilliseconds !== null &&
    record.rawResponseId !== null &&
    record.rawResponseMediaType !== null &&
    record.rawResponseByteSize !== null &&
    record.rawResponseSha256 !== null &&
    record.rawResponseRetention !== null &&
    record.rawResponseExpiresAt !== null;
  return {
    id: record.id,
    question: record.question,
    status,
    retrieval: record.retrieval,
    ...(status === 'succeeded' && record.synthesis !== null
      ? { synthesis: record.synthesis }
      : {}),
    citations:
      status === 'succeeded'
        ? cited.map((citation) => ({
            citationId: citation.citationId,
            sourceKind:
              citation.sourceKind as GroundedAnswer['citations'][number]['sourceKind'],
            layer:
              citation.layer as GroundedAnswer['citations'][number]['layer'],
            sourceId: citation.sourceId,
            sourceRevisionId: citation.sourceRevisionId,
            sourceRevision: citation.sourceRevision,
            ...(citation.journalDate === null
              ? {}
              : { journalDate: citation.journalDate }),
            authority: citation.authority,
            retrievedQuote: citation.retrievedQuote,
            evidence: {
              normalization: 'NFC_LF_V1' as const,
              offsetUnit: 'utf16_code_unit' as const,
              startUtf16: citation.startUtf16,
              endUtf16: citation.endUtf16,
              quoteSha256: citation.quoteSha256,
            },
            href: citation.href,
          }))
        : [],
    ...(status === 'failed' && record.failureCode !== null
      ? { failureCode: record.failureCode }
      : {}),
    ...(lineageAvailable
      ? {
          lineage: {
            prompt: {
              id: 'grounded-answer' as const,
              version: record.promptVersion,
              templateHash: record.promptTemplateHash,
              effectiveMessagesHash: record.effectiveMessagesHash as string,
            },
            provider: record.provider as Record<string, unknown>,
            model: record.model as Record<string, unknown>,
            effectiveConfiguration: record.effectiveConfiguration as Record<
              string,
              unknown
            >,
            usage: record.usage as Record<string, unknown>,
            processingTimeMilliseconds: Number(
              record.processingTimeMilliseconds,
            ),
            rawResponse: {
              id: record.rawResponseId as string,
              mediaType: record.rawResponseMediaType as string,
              byteSize: String(record.rawResponseByteSize),
              sha256: record.rawResponseSha256 as string,
              retention: record.rawResponseRetention as string,
              expiresAt: (record.rawResponseExpiresAt as Date).toISOString(),
            },
          },
        }
      : {}),
    requestedAt: record.requestedAt.toISOString(),
    ...(record.completedAt === null
      ? {}
      : { completedAt: record.completedAt.toISOString() }),
  };
}

export class PostgresGroundedAnswerService implements GroundedAnswerService {
  private readonly repository: GroundedAnswerRepository;

  public constructor(
    database: JournalDatabase,
    private readonly boss: PgBoss,
    private readonly searchService: SearchService,
    repository = new GroundedAnswerRepository(database),
  ) {
    this.repository = repository;
  }

  public async ask(
    ownerId: string,
    request: GroundedAnswerRequest,
    idempotencyKey: string,
  ): Promise<GroundedAnswer> {
    const retrieval = await this.searchService.search(
      ownerId,
      searchRequest(request),
    );
    const created = await this.repository.create({
      boss: this.boss,
      ownerId,
      request,
      requestHash: requestHash(request),
      idempotencyKey,
      retrieval: retrieval.retrieval,
      fragmentIds: retrieval.items.map(({ fragmentId }) => fragmentId),
    });
    return this.get(ownerId, created.answerId);
  }

  public async get(ownerId: string, answerId: string): Promise<GroundedAnswer> {
    const record = await this.repository.loadForOwner(answerId, ownerId);
    if (record === undefined) throw new GroundedAnswerNotFoundError();
    return response(record);
  }
}
