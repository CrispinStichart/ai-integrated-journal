import type { ContributionResource } from '@journal/contracts';
import {
  DeletedContributionError,
  JournalRecordNotFoundError,
} from '@journal/database';
import {
  DomainInvariantError,
  OptimisticConcurrencyError,
} from '@journal/domain';
import { silentLogger } from '@journal/observability';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createApiApp } from '../src/app.js';
import { createInMemoryEventFeed } from '../src/events.js';
import {
  IdempotencyConflictError,
  InvalidJournalCursorError,
  type JournalService,
} from '../src/journal-service.js';

const OWNER_ID = '019c5b90-0000-7000-8000-000000000010';
const DAY_ID = '019c5b90-0000-7000-8000-000000000011';
const CONTRIBUTION_ID = '019c5b90-0000-7000-8000-000000000012';
const REVISION_ID = '019c5b90-0000-7000-8000-000000000013';
const CORRELATION_ID = '019c5b90-0000-7000-8000-000000000014';
const contribution: ContributionResource = {
  id: CONTRIBUTION_ID,
  journalDayId: DAY_ID,
  journalDate: '2026-08-16',
  authorId: OWNER_ID,
  sourceType: 'typed_text',
  capturedAt: '2026-08-16T12:00:00.000Z',
  capturedTimezone: 'America/New_York',
  journalTimezone: 'America/New_York',
  journalDateAssignment: 'default',
  currentRevision: {
    id: REVISION_ID,
    contributionId: CONTRIBUTION_ID,
    revision: 1,
    text: 'Durable source text',
    authority: 'manual',
    authorId: OWNER_ID,
    createdAt: '2026-08-16T12:00:00.000Z',
  },
};
const recordingContribution: ContributionResource = {
  ...contribution,
  sourceType: 'recording',
  currentRevision: undefined,
  recording: {
    id: '019c5b90-0000-7000-8000-000000000015',
    mimeType: 'audio/webm;codecs=opus',
    persistenceState: 'durable',
  },
};

function service(): JournalService {
  return {
    listDays: vi.fn(async () => ({
      items: [{ id: DAY_ID, journalDate: '2026-08-16', contributionCount: 1 }],
      hasMore: false,
    })),
    getDay: vi.fn(async () => ({
      id: DAY_ID,
      journalDate: '2026-08-16',
      createdAt: '2026-08-16T12:00:00.000Z',
      contributions: [contribution],
    })),
    getContribution: vi.fn(async () => contribution),
    listRevisions: vi.fn(async () => ({
      items:
        contribution.currentRevision === undefined
          ? []
          : [contribution.currentRevision],
      hasMore: false,
    })),
    create: vi.fn(async () => ({ contribution, replayed: false })),
    edit: vi.fn(async () => ({ contribution, replayed: false })),
    move: vi.fn(async () => ({ contribution, replayed: false })),
    delete: vi.fn(async () => ({
      contribution: { ...contribution, deletedAt: '2026-08-16T13:00:00.000Z' },
      replayed: false,
    })),
    restore: vi.fn(async () => ({ contribution, replayed: false })),
  };
}

function app(journalService: JournalService) {
  return createApiApp({
    authenticator: {
      authenticate: async (incoming) =>
        incoming.get('authorization') === 'Bearer valid'
          ? { ownerId: OWNER_ID }
          : undefined,
    },
    createCorrelationId: () => CORRELATION_ID,
    eventFeed: createInMemoryEventFeed(),
    healthProbes: [],
    journalService,
    logger: silentLogger,
  });
}

describe('Journal REST API (DATA-001–DATA-013, DATA-026, TIME-001–TIME-003, STATE-006–STATE-007)', () => {
  it('returns authenticated calendar summaries, complete days, and immutable revision history', async () => {
    const api = app(service());
    const calendar = await request(api)
      .get('/api/v1/journal-days?limit=10')
      .set('authorization', 'Bearer valid')
      .expect(200);
    expect(calendar.body.items[0]).toMatchObject({
      journalDate: '2026-08-16',
      contributionCount: 1,
    });
    const day = await request(api)
      .get('/api/v1/journal-days/2026-08-16')
      .set('authorization', 'Bearer valid')
      .expect(200);
    expect(day.body.contributions).toHaveLength(1);
    const history = await request(api)
      .get(`/api/v1/contributions/${CONTRIBUTION_ID}/revisions`)
      .set('authorization', 'Bearer valid')
      .expect(200);
    expect(history.body.items).toEqual([contribution.currentRevision]);

    const single = await request(api)
      .get(`/api/v1/contributions/${CONTRIBUTION_ID}?includeDeleted=true`)
      .set('authorization', 'Bearer valid')
      .expect(200);
    expect(single.headers.etag).toBe('"revision-1"');
  });

  it('creates typed contributions with required idempotency and returns a strong revision ETag', async () => {
    const journalService = service();
    const response = await request(app(journalService))
      .post('/api/v1/contributions')
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'offline-create-1')
      .send({
        contributionId: CONTRIBUTION_ID,
        revisionId: REVISION_ID,
        proposedJournalDayId: DAY_ID,
        sourceType: 'typed_text',
        text: 'Durable source text',
        capturedAt: '2026-08-16T12:00:00.000Z',
        capturedTimezone: 'America/New_York',
        journalTimezone: 'America/New_York',
        journalDate: '2026-08-16',
        journalDateAssignment: 'default',
      })
      .expect(201);
    expect(response.headers.etag).toBe('"revision-1"');
    expect(response.body.idempotency).toEqual({
      key: 'offline-create-1',
      replayed: false,
    });
    expect(journalService.create).toHaveBeenCalledOnce();

    const missing = await request(app(service()))
      .post('/api/v1/contributions')
      .set('authorization', 'Bearer valid')
      .send({})
      .expect(428);
    expect(missing.body.code).toBe('idempotency_key_required');
  });

  it('edits, moves, deletes, and restores only with an If-Match precondition', async () => {
    const journalService = service();
    const api = app(journalService);
    await request(api)
      .patch(`/api/v1/contributions/${CONTRIBUTION_ID}`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'offline-edit-1')
      .set('if-match', '"revision-1"')
      .send({ revisionId: REVISION_ID, text: 'Correction' })
      .expect(200);
    await request(api)
      .post(`/api/v1/contributions/${CONTRIBUTION_ID}/move`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'offline-move-1')
      .set('if-match', '"revision-1"')
      .send({ proposedJournalDayId: DAY_ID, journalDate: '2030-01-01' })
      .expect(200);
    await request(api)
      .delete(`/api/v1/contributions/${CONTRIBUTION_ID}`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'offline-delete-1')
      .set('if-match', '"revision-1"')
      .expect(200);
    await request(api)
      .post(`/api/v1/contributions/${CONTRIBUTION_ID}/restore`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'offline-restore-1')
      .set('if-match', '"revision-1"')
      .expect(200);
    expect(journalService.move).toHaveBeenCalledWith(
      OWNER_ID,
      CONTRIBUTION_ID,
      expect.objectContaining({ journalDate: '2030-01-01' }),
      1,
      'offline-move-1',
      CORRELATION_ID,
    );
  });

  it('[CAP-007][AC-040] moves a revisionless recording with a strong revision-zero ETag', async () => {
    const journalService = service();
    vi.mocked(journalService.getContribution).mockResolvedValue(
      recordingContribution,
    );
    vi.mocked(journalService.move).mockResolvedValue({
      contribution: {
        ...recordingContribution,
        journalDate: '2026-08-15',
        journalDateAssignment: 'user_override',
      },
      replayed: false,
    });
    const api = app(journalService);
    const read = await request(api)
      .get(`/api/v1/contributions/${CONTRIBUTION_ID}`)
      .set('authorization', 'Bearer valid')
      .expect(200);
    expect(read.headers.etag).toBe('"revision-0"');

    const moved = await request(api)
      .post(`/api/v1/contributions/${CONTRIBUTION_ID}/move`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'recording-move-1')
      .set('if-match', '"revision-0"')
      .send({ proposedJournalDayId: DAY_ID, journalDate: '2026-08-15' })
      .expect(200);

    expect(moved.headers.etag).toBe('"revision-0"');
    expect(journalService.move).toHaveBeenCalledWith(
      OWNER_ID,
      CONTRIBUTION_ID,
      expect.objectContaining({ journalDate: '2026-08-15' }),
      0,
      'recording-move-1',
      CORRELATION_ID,
    );
  });

  it('isolates unauthenticated reads and maps stale ETags to RFC 9457 problems', async () => {
    await request(app(service())).get('/api/v1/journal-days').expect(401);
    const journalService = service();
    vi.mocked(journalService.edit).mockRejectedValueOnce(
      new OptimisticConcurrencyError(1, 2),
    );
    const response = await request(app(journalService))
      .patch(`/api/v1/contributions/${CONTRIBUTION_ID}`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'offline-edit-2')
      .set('if-match', '"revision-1"')
      .send({ revisionId: REVISION_ID, text: 'Stale correction' })
      .expect(412);
    expect(response.body).toMatchObject({
      code: 'etag_mismatch',
      status: 412,
      correlationId: CORRELATION_ID,
    });
  });

  it('validates path, query, and conditional request metadata', async () => {
    const api = app(service());
    await request(api)
      .get('/api/v1/journal-days/not-a-date')
      .set('authorization', 'Bearer valid')
      .expect(400);
    await request(api)
      .get('/api/v1/journal-days?limit=1000')
      .set('authorization', 'Bearer valid')
      .expect(400);
    const missing = await request(api)
      .patch(`/api/v1/contributions/${CONTRIBUTION_ID}`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'offline-edit-3')
      .send({ revisionId: REVISION_ID, text: 'Correction' })
      .expect(428);
    expect(missing.body.code).toBe('precondition_required');
    await request(api)
      .patch(`/api/v1/contributions/${CONTRIBUTION_ID}`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'offline-edit-4')
      .set('if-match', '"not-a-revision"')
      .send({ revisionId: REVISION_ID, text: 'Correction' })
      .expect(400);
  });

  it('returns not found for absent days, contributions, and revision owners', async () => {
    const journalService = service();
    vi.mocked(journalService.getDay).mockResolvedValueOnce(undefined);
    vi.mocked(journalService.getContribution).mockResolvedValue(undefined);
    vi.mocked(journalService.listRevisions).mockResolvedValueOnce({
      items: [],
      hasMore: false,
    });
    const api = app(journalService);
    await request(api)
      .get('/api/v1/journal-days/2026-08-16')
      .set('authorization', 'Bearer valid')
      .expect(404);
    await request(api)
      .get(`/api/v1/contributions/${CONTRIBUTION_ID}`)
      .set('authorization', 'Bearer valid')
      .expect(404);
    await request(api)
      .get(`/api/v1/contributions/${CONTRIBUTION_ID}/revisions`)
      .set('authorization', 'Bearer valid')
      .expect(404);
  });

  it('reports replayed creation and stable journal service failures', async () => {
    const journalService = service();
    vi.mocked(journalService.create).mockResolvedValueOnce({
      contribution,
      replayed: true,
    });
    const created = await request(app(journalService))
      .post('/api/v1/contributions')
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'offline-replay-1')
      .send({
        contributionId: CONTRIBUTION_ID,
        revisionId: REVISION_ID,
        proposedJournalDayId: DAY_ID,
        sourceType: 'typed_text',
        text: 'Durable source text',
        capturedAt: '2026-08-16T12:00:00.000Z',
        capturedTimezone: 'America/New_York',
        journalTimezone: 'America/New_York',
        journalDate: '2026-08-16',
        journalDateAssignment: 'default',
      })
      .expect(200);
    expect(created.body.idempotency.replayed).toBe(true);

    const failures = [
      [new JournalRecordNotFoundError(), 404, 'not_found'],
      [new IdempotencyConflictError(), 409, 'idempotency_key_reused'],
      [new DeletedContributionError(), 409, 'conflict'],
      [new InvalidJournalCursorError(), 400, 'validation_failed'],
      [new DomainInvariantError('invalid'), 400, 'validation_failed'],
    ] as const;
    for (const [error, status, code] of failures) {
      const failing = service();
      vi.mocked(failing.listDays).mockRejectedValueOnce(error);
      const response = await request(app(failing))
        .get('/api/v1/journal-days')
        .set('authorization', 'Bearer valid')
        .expect(status);
      expect(response.body.code).toBe(code);
    }
  });
});
