import type { NudgeDayResource, NudgePreference } from '@journal/contracts';
import { silentLogger } from '@journal/observability';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../src/app.js';
import type { AuthenticationService } from '../src/auth.js';
import { createInMemoryEventFeed } from '../src/events.js';
import type { NudgeService } from '../src/nudge-service.js';

const OWNER_ID = '019c5b90-0000-7000-8000-000000000040';
const DAY_ID = '019c5b90-0000-7000-8000-000000000041';
const DIGEST_ID = '019c5b90-0000-7000-8000-000000000042';
const EVALUATION_ID = '019c5b90-0000-7000-8000-000000000043';
const ITEM_ID = '019c5b90-0000-7000-8000-000000000044';
const PROCESSOR_ID = '019c5b90-0000-7000-8000-000000000045';
const VERSION_ID = '019c5b90-0000-7000-8000-000000000046';
const CONTRIBUTION_ID = '019c5b90-0000-7000-8000-000000000047';
const REVISION_ID = '019c5b90-0000-7000-8000-000000000048';
const CORRELATION_ID = '019c5b90-0000-7000-8000-000000000049';
const NOW = '2026-08-23T20:00:00.000Z';

const day: NudgeDayResource = {
  journalDate: '2026-08-23',
  evaluations: [
    {
      id: EVALUATION_ID,
      journalDayId: DAY_ID,
      journalDate: '2026-08-23',
      processorId: PROCESSOR_ID,
      processorVersionId: VERSION_ID,
      processorName: 'Synthetic sleep',
      state: 'pending_user_response',
      revision: 2,
      allowNotApplicable: true,
      prompt: 'How did you sleep?',
      supportingRunId: VERSION_ID,
      evaluatedAt: NOW,
      updatedAt: NOW,
    },
  ],
  digest: {
    id: DIGEST_ID,
    journalDayId: DAY_ID,
    journalDate: '2026-08-23',
    status: 'published',
    revision: 1,
    scheduledAt: NOW,
    publishedAt: NOW,
    items: [
      {
        id: ITEM_ID,
        evaluationId: EVALUATION_ID,
        processorName: 'Synthetic sleep',
        prompt: 'How did you sleep?',
        allowNotApplicable: true,
        state: 'pending_user_response',
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  },
};
const preference: NudgePreference = {
  quietStartHour: 21,
  quietEndHour: 8,
  dailyLimit: 1,
  revision: 1,
  ownerTimezone: 'America/Chicago',
  updatedAt: NOW,
};

function service(): NudgeService {
  return {
    getDay: vi.fn(async () => day),
    getPreferences: vi.fn(async () => preference),
    act: vi.fn(async () => {
      if (day.digest === undefined) throw new Error('Digest fixture missing.');
      return {
        day: { ...day, digest: { ...day.digest, revision: 2 } },
        responseContributionId: CONTRIBUTION_ID,
        replayed: false,
      };
    }),
    updatePreferences: vi.fn(async () => ({
      preference: { ...preference, quietStartHour: 22, revision: 2 },
      replayed: false,
    })),
  };
}

function app(nudgeService: NudgeService, assertCsrf = vi.fn()) {
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
    authenticationService: { assertCsrf } as unknown as AuthenticationService,
    createCorrelationId: () => CORRELATION_ID,
    eventFeed: createInMemoryEventFeed(),
    healthProbes: [],
    logger: silentLogger,
    nudgeService,
  });
}

describe('nudge API', () => {
  it('[NUDGE-002][NUDGE-005][SEC-001] returns owner-scoped exact-version requirement state and a strong digest ETag', async () => {
    const nudgeService = service();
    await request(app(nudgeService))
      .get('/api/v1/nudges?journalDate=2026-08-23')
      .expect(401);
    const response = await request(app(nudgeService))
      .get('/api/v1/nudges?journalDate=2026-08-23')
      .set('authorization', 'Bearer valid')
      .expect(200)
      .expect('etag', '"nudge-1"');
    expect(response.body.evaluations[0]).toMatchObject({
      state: 'pending_user_response',
      processorVersionId: VERSION_ID,
    });
    expect(nudgeService.getDay).toHaveBeenCalledWith(OWNER_ID, '2026-08-23');
  });

  it('[DATA-013][NUDGE-006][STATE-004][SEC-001] requires CSRF, idempotency, and ETag for a durable answer action', async () => {
    const nudgeService = service();
    const assertCsrf = vi.fn();
    const body = {
      action: 'answer',
      itemId: ITEM_ID,
      text: 'Synthetic answer.',
      contributionId: CONTRIBUTION_ID,
      revisionId: REVISION_ID,
      capturedAt: NOW,
      capturedTimezone: 'Etc/UTC',
    };
    await request(app(nudgeService, assertCsrf))
      .post(`/api/v1/nudges/${DIGEST_ID}/actions`)
      .set('authorization', 'Bearer valid')
      .send(body)
      .expect(428);
    const response = await request(app(nudgeService, assertCsrf))
      .post(`/api/v1/nudges/${DIGEST_ID}/actions`)
      .set('authorization', 'Bearer valid')
      .set('x-csrf-token', 'csrf')
      .set('idempotency-key', 'nudge-answer-1')
      .set('if-match', '"nudge-1"')
      .send(body)
      .expect(200)
      .expect('etag', '"nudge-2"');
    expect(assertCsrf).toHaveBeenCalled();
    expect(response.body.responseContributionId).toBe(CONTRIBUTION_ID);
    expect(nudgeService.act).toHaveBeenCalledWith(
      OWNER_ID,
      DIGEST_ID,
      1,
      body,
      'nudge-answer-1',
      CORRELATION_ID,
    );
  });

  it('[NUDGE-005][TIME-001][STATE-004] exposes configurable owner-timezone quiet hours and limits conditionally', async () => {
    const nudgeService = service();
    await request(app(nudgeService))
      .get('/api/v1/nudges/preferences')
      .set('authorization', 'Bearer valid')
      .expect(200)
      .expect('etag', '"nudge-preferences-1"');
    await request(app(nudgeService))
      .put('/api/v1/nudges/preferences')
      .set('authorization', 'Bearer valid')
      .set('x-csrf-token', 'csrf')
      .set('idempotency-key', 'nudge-pref-1')
      .set('if-match', '"nudge-preferences-1"')
      .send({ quietStartHour: 22, quietEndHour: 7, dailyLimit: 1 })
      .expect(200)
      .expect('etag', '"nudge-preferences-2"');
    expect(nudgeService.updatePreferences).toHaveBeenCalledWith(
      OWNER_ID,
      1,
      { quietStartHour: 22, quietEndHour: 7, dailyLimit: 1 },
      'nudge-pref-1',
    );
  });
});
