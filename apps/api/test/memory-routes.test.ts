import type { FeedbackResource, MemoryResource } from '@journal/contracts';
import { silentLogger } from '@journal/observability';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../src/app.js';
import type { AuthenticationService } from '../src/auth.js';
import { createInMemoryEventFeed } from '../src/events.js';
import type { MemoryService } from '../src/memory-service.js';

const OWNER_ID = '019c5b90-0000-7000-8000-000000000020';
const MEMORY_ID = '019c5b90-0000-7000-8000-000000000021';
const REVISION_ID = '019c5b90-0000-7000-8000-000000000022';
const TARGET_ID = '019c5b90-0000-7000-8000-000000000023';
const FEEDBACK_ID = '019c5b90-0000-7000-8000-000000000024';
const CORRELATION_ID = '019c5b90-0000-7000-8000-000000000025';
const NOW = '2026-08-23T20:00:00.000Z';

const memory: MemoryResource = {
  id: MEMORY_ID,
  revision: 1,
  currentRevision: {
    id: REVISION_ID,
    revision: 1,
    type: 'correction_rule',
    content: 'Synthetic correction context.',
    rationale: 'Explicit owner correction.',
    creator: 'user',
    approvalState: 'approved',
    scope: { kind: 'global_transcription' },
    enabled: true,
    createdAt: NOW,
  },
  history: [],
  historyTruncated: false,
  createdAt: NOW,
  updatedAt: NOW,
};
const feedback: FeedbackResource = {
  id: FEEDBACK_ID,
  target: { kind: 'transcript_revision', id: TARGET_ID },
  message: 'Synthetic feedback.',
  classifiedScope: { kind: 'global_transcription' },
  memoryId: MEMORY_ID,
  createdAt: NOW,
};

function service(): MemoryService {
  return {
    list: vi.fn(async () => ({ items: [memory] })),
    get: vi.fn(async () => memory),
    createFeedback: vi.fn(async () => ({ feedback, memory, replayed: false })),
    mutate: vi.fn(async () => ({
      memory: { ...memory, revision: 2 },
      replayed: false,
    })),
  };
}

function app(memoryService: MemoryService, assertCsrf = vi.fn()) {
  const authenticationService = {
    assertCsrf,
  } as unknown as AuthenticationService;
  return createApiApp({
    authenticator: {
      authenticate: async (incoming) =>
        incoming.get('authorization') === 'Bearer valid'
          ? {
              ownerId: OWNER_ID,
              sessionId: 'session',
              displayName: 'Owner',
              csrfToken: 'csrf',
              expiresAt: new Date(NOW),
            }
          : undefined,
    },
    authenticationService,
    createCorrelationId: () => CORRELATION_ID,
    eventFeed: createInMemoryEventFeed(),
    healthProbes: [],
    logger: silentLogger,
    memoryService,
  });
}

describe('feedback and memory API', () => {
  it('[MEM-004][SEC-001] requires authentication and passes bounded search controls', async () => {
    const memoryService = service();
    await request(app(memoryService)).get('/api/v1/memories').expect(401);
    const response = await request(app(memoryService))
      .get('/api/v1/memories?q=synthetic&limit=20&includeDisabled=true')
      .set('authorization', 'Bearer valid')
      .expect(200);
    expect(response.body.items).toHaveLength(1);
    expect(memoryService.list).toHaveBeenCalledWith(OWNER_ID, {
      q: 'synthetic',
      limit: 20,
      includeDisabled: true,
      includeDeleted: false,
    });
    const detail = await request(app(memoryService))
      .get(`/api/v1/memories/${MEMORY_ID}`)
      .set('authorization', 'Bearer valid')
      .expect(200)
      .expect('etag', '"memory-1"');
    expect(detail.body).toMatchObject({ id: MEMORY_ID, revision: 1 });
    expect(memoryService.get).toHaveBeenCalledWith(OWNER_ID, MEMORY_ID);
  });

  it('[MEM-001][FB-003][STATE-004] requires explicit idempotency and approval for a persistent feedback command', async () => {
    const memoryService = service();
    const body = {
      mode: 'correct_and_remember',
      target: { kind: 'transcript_revision', id: TARGET_ID },
      message: 'Synthetic feedback.',
      memory: {
        type: 'correction_rule',
        content: 'Synthetic correction context.',
        rationale: 'Explicit owner correction.',
        scope: { kind: 'global_transcription' },
      },
      approval: 'approved',
    };
    await request(app(memoryService))
      .post('/api/v1/feedback')
      .set('authorization', 'Bearer valid')
      .send(body)
      .expect(428);
    await request(app(memoryService))
      .post('/api/v1/feedback')
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'feedback-1')
      .send({ ...body, approval: 'pending' })
      .expect(400);
    const response = await request(app(memoryService))
      .post('/api/v1/feedback')
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'feedback-1')
      .send(body)
      .expect(201)
      .expect('etag', '"memory-1"');
    expect(response.body.memory.currentRevision.approvalState).toBe('approved');
    expect(memoryService.createFeedback).toHaveBeenCalledWith(
      OWNER_ID,
      body,
      'feedback-1',
      CORRELATION_ID,
    );
  });

  it('[MEM-004][AC-031][STATE-004] enforces CSRF plus strong ETag on memory lifecycle controls', async () => {
    const memoryService = service();
    const assertCsrf = vi.fn();
    await request(app(memoryService, assertCsrf))
      .post(`/api/v1/memories/${MEMORY_ID}/mutations`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'disable-1')
      .send({ operation: 'disable' })
      .expect(428);
    await request(app(memoryService, assertCsrf))
      .post(`/api/v1/memories/${MEMORY_ID}/mutations`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'disable-1')
      .set('if-match', '"memory-1"')
      .set('x-csrf-token', 'csrf')
      .send({ operation: 'disable' })
      .expect(200)
      .expect('etag', '"memory-2"');
    expect(assertCsrf).toHaveBeenCalled();
    expect(memoryService.mutate).toHaveBeenCalledWith(
      OWNER_ID,
      MEMORY_ID,
      1,
      { operation: 'disable' },
      'disable-1',
      CORRELATION_ID,
    );
  });
});
