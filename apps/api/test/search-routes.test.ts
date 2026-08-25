import type { GroundedAnswer, LexicalSearchResult } from '@journal/contracts';
import { silentLogger } from '@journal/observability';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../src/app.js';
import { createInMemoryEventFeed } from '../src/events.js';
import {
  SearchCursorError,
  type SearchService,
} from '../src/search-service.js';
import type { GroundedAnswerService } from '../src/grounded-answer-service.js';

const OWNER_ID = '019c5b90-0000-7000-8000-000000000040';
const REVISION_ID = '019c5b90-0000-7000-8000-000000000041';
const SOURCE_ID = '019c5b90-0000-7000-8000-000000000042';
const result: LexicalSearchResult = {
  fragmentId: REVISION_ID,
  sourceKind: 'contribution_revision',
  layer: 'typed_text',
  sourceId: SOURCE_ID,
  sourceRevisionId: REVISION_ID,
  sourceRevision: 1,
  journalDate: '2026-08-25',
  contributionId: SOURCE_ID,
  contributionType: 'typed_text',
  authority: 'manual',
  score: 0.5,
  snippet: [{ text: 'Morning walk', highlighted: true }],
  href: `/journal/2026-08-25?source=contribution_revision&revision=${REVISION_ID}`,
};

function app(
  service: SearchService,
  groundedAnswerService?: GroundedAnswerService,
) {
  return createApiApp({
    authenticator: {
      authenticate: async (incoming) =>
        incoming.get('authorization') === 'Bearer valid'
          ? { ownerId: OWNER_ID }
          : undefined,
    },
    eventFeed: createInMemoryEventFeed(),
    healthProbes: [],
    logger: silentLogger,
    ...(groundedAnswerService === undefined ? {} : { groundedAnswerService }),
    searchService: service,
  });
}

const answer: GroundedAnswer = {
  id: '019c5b90-0000-7000-8000-000000000043',
  question: 'What happened?',
  status: 'insufficient_support',
  retrieval: { requestedMode: 'hybrid', effectiveMode: 'lexical' },
  citations: [],
  requestedAt: '2026-08-25T04:00:00.000Z',
  completedAt: '2026-08-25T04:00:00.000Z',
};

describe('lexical search API', () => {
  it('[SEARCH-001][SEARCH-003][SEARCH-005][SEC-001] validates and owner-scopes complete lexical filters', async () => {
    const service: SearchService = {
      search: vi.fn(async () => ({
        items: [result],
        retrieval: {
          requestedMode: 'lexical' as const,
          effectiveMode: 'lexical' as const,
        },
        nextCursor: 'next_cursor',
      })),
    };
    await request(app(service)).get('/api/v1/search?q=walk').expect(401);
    const response = await request(app(service))
      .get(
        `/api/v1/search?q=walk&mode=hybrid&layers=typed_text,corrected&dateFrom=2026-08-01&dateTo=2026-08-25&contributionTypes=typed_text&authority=manual&entity=Nicolette`,
      )
      .set('authorization', 'Bearer valid')
      .expect('cache-control', 'private, no-store')
      .expect(200);
    expect(response.body.items[0]).toMatchObject({
      sourceRevisionId: REVISION_ID,
      authority: 'manual',
    });
    expect(service.search).toHaveBeenCalledWith(
      OWNER_ID,
      expect.objectContaining({
        layers: ['typed_text', 'corrected'],
        mode: 'hybrid',
        entity: 'Nicolette',
      }),
    );
  });

  it('[SEARCH-001][SEARCH-006] rejects malformed filters and stale cursors without running retrieval', async () => {
    const service: SearchService = {
      search: vi.fn(async () => {
        throw new SearchCursorError();
      }),
    };
    await request(app(service))
      .get('/api/v1/search?q=walk&dateFrom=2026-09-01&dateTo=2026-08-01')
      .set('authorization', 'Bearer valid')
      .expect(400);
    expect(service.search).not.toHaveBeenCalled();
    await request(app(service))
      .get('/api/v1/search?q=walk&cursor=valid_shape')
      .set('authorization', 'Bearer valid')
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('invalid_cursor'));
  });

  it('[SEARCH-003][SEARCH-007][SEC-001][STATE-004] authenticates, validates, and idempotently queues owner-scoped grounded answers', async () => {
    const search: SearchService = {
      search: vi.fn(async () => ({ items: [], retrieval: answer.retrieval })),
    };
    const grounded: GroundedAnswerService = {
      ask: vi.fn(async () => answer),
      get: vi.fn(async () => answer),
    };
    await request(app(search, grounded))
      .post('/api/v1/search/answers')
      .set('authorization', 'Bearer valid')
      .send({ question: 'What happened?' })
      .expect(428);
    await request(app(search, grounded))
      .post('/api/v1/search/answers')
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'grounded-fixture-1')
      .send({ question: '' })
      .expect(400);
    const response = await request(app(search, grounded))
      .post('/api/v1/search/answers')
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'grounded-fixture-1')
      .send({ question: 'What happened?', mode: 'hybrid' })
      .expect('cache-control', 'private, no-store')
      .expect(202);
    expect(response.body.status).toBe('insufficient_support');
    expect(grounded.ask).toHaveBeenCalledWith(
      OWNER_ID,
      expect.objectContaining({ question: 'What happened?', mode: 'hybrid' }),
      'grounded-fixture-1',
    );
    await request(app(search, grounded))
      .get(`/api/v1/search/answers/${answer.id}`)
      .set('authorization', 'Bearer valid')
      .expect(200);
    expect(grounded.get).toHaveBeenCalledWith(OWNER_ID, answer.id);
  });
});
