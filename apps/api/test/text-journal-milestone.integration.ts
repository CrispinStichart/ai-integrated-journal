import {
  createDatabaseClient,
  migrateDatabase,
  type DatabaseClient,
  type JournalDatabase,
} from '@journal/database';
import { createUuidV7 } from '@journal/domain';
import { silentLogger } from '@journal/observability';
import { createPostgresTestContainer } from '@journal/test-support';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiApp } from '../src/app.js';
import { createPostgresAuthenticationStore } from '../src/auth-store.js';
import { AuthenticationService } from '../src/auth.js';
import { createInMemoryEventFeed } from '../src/events.js';
import { PostgresJournalService } from '../src/journal-service.js';

const JOURNAL_DATE = '2026-08-16';
const MOVED_DATE = '2030-01-01';
const PASSWORD = 'source-only journal password';

function milestoneApp(database: JournalDatabase) {
  const authenticationService = new AuthenticationService({
    store: createPostgresAuthenticationStore(database),
    rpId: 'localhost',
    expectedOrigin: 'http://localhost:5173',
    secureCookies: false,
  });

  return createApiApp({
    authenticator: authenticationService,
    authenticationService,
    createCorrelationId: () => createUuidV7<'correlation'>(),
    eventFeed: createInMemoryEventFeed(),
    healthProbes: [
      {
        name: 'postgresql',
        requiredForReadiness: true,
        check: async () => {
          await database.execute('select 1');
          return { status: 'healthy' as const };
        },
      },
      {
        name: 'providers',
        requiredForReadiness: false,
        check: async () => ({ status: 'not_configured' as const }),
      },
      {
        name: 'worker',
        requiredForReadiness: false,
        check: async () => ({
          status: 'unhealthy' as const,
          detail: 'stopped_for_release_test',
        }),
      },
    ],
    journalService: new PostgresJournalService(database),
    logger: silentLogger,
  });
}

describe('Phase 2 text-journal milestone', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('[ARCH-005][DATA-001–DATA-004][DATA-010–DATA-012][TIME-001–TIME-003][STATE-006–STATE-007][AC-001][AC-003] preserves the complete source-only workflow across optional-service failure and restart', async () => {
    const contributionIds = [
      createUuidV7<'contribution'>(),
      createUuidV7<'contribution'>(),
    ];
    const dayIds = [
      createUuidV7<'journal-day'>(),
      createUuidV7<'journal-day'>(),
    ];
    const initialRevisionIds = [
      createUuidV7<'contribution-revision'>(),
      createUuidV7<'contribution-revision'>(),
    ];
    const firstAgent = request.agent(milestoneApp(client.database));
    const bootstrap = await firstAgent
      .post('/api/v1/auth/bootstrap')
      .send({
        displayName: 'Milestone owner',
        journalTimeZone: 'America/New_York',
        password: PASSWORD,
      })
      .expect(201);
    const firstCsrf = bootstrap.body.csrfToken as string;

    const createContribution = (index: number, text: string) =>
      firstAgent
        .post('/api/v1/contributions')
        .set('idempotency-key', `milestone-create-${index}`)
        .set('x-csrf-token', firstCsrf)
        .send({
          contributionId: contributionIds[index],
          revisionId: initialRevisionIds[index],
          proposedJournalDayId: dayIds[0],
          sourceType: 'typed_text',
          text,
          capturedAt: `2026-08-16T1${index}:00:00.000Z`,
          capturedTimezone: 'America/New_York',
          journalTimezone: 'America/New_York',
          journalDate: JOURNAL_DATE,
          journalDateAssignment: 'default',
        });

    const firstCreate = await createContribution(0, 'Morning reflection')
      .expect(201)
      .expect('etag', '"revision-1"');
    await createContribution(0, 'Morning reflection').expect(200);
    expect(firstCreate.body.idempotency.replayed).toBe(false);

    await createContribution(1, 'Evening reflection').expect(201);
    const sharedDay = await firstAgent
      .get(`/api/v1/journal-days/${JOURNAL_DATE}`)
      .expect(200);
    expect(sharedDay.body.contributions).toMatchObject([
      {
        id: contributionIds[0],
        sourceType: 'typed_text',
        currentRevision: { text: 'Morning reflection' },
      },
      {
        id: contributionIds[1],
        sourceType: 'typed_text',
        currentRevision: { text: 'Evening reflection' },
      },
    ]);

    const health = await firstAgent.get('/health/details').expect(200);
    expect(health.body).toMatchObject({
      status: 'healthy',
      dependencies: {
        postgresql: { status: 'healthy' },
        providers: { status: 'not_configured' },
        worker: {
          status: 'unhealthy',
          detail: 'stopped_for_release_test',
        },
      },
    });

    await firstAgent
      .patch(`/api/v1/contributions/${contributionIds[0]}`)
      .set('idempotency-key', 'milestone-edit-before-restart')
      .set('if-match', '"revision-1"')
      .set('x-csrf-token', firstCsrf)
      .send({
        revisionId: createUuidV7<'contribution-revision'>(),
        text: 'Morning reflection, corrected',
        editReason: 'Clarified wording',
      })
      .expect(200)
      .expect('etag', '"revision-2"');
    await firstAgent
      .post(`/api/v1/contributions/${contributionIds[1]}/move`)
      .set('idempotency-key', 'milestone-move')
      .set('if-match', '"revision-1"')
      .set('x-csrf-token', firstCsrf)
      .send({ proposedJournalDayId: dayIds[1], journalDate: MOVED_DATE })
      .expect(200);
    await firstAgent
      .delete(`/api/v1/contributions/${contributionIds[0]}`)
      .set('idempotency-key', 'milestone-delete')
      .set('if-match', '"revision-2"')
      .set('x-csrf-token', firstCsrf)
      .expect(200);
    await firstAgent
      .post(`/api/v1/contributions/${contributionIds[0]}/restore`)
      .set('idempotency-key', 'milestone-restore')
      .set('if-match', '"revision-2"')
      .set('x-csrf-token', firstCsrf)
      .expect(200);

    await client.close();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });

    const restartedAgent = request.agent(milestoneApp(client.database));
    const login = await restartedAgent
      .post('/api/v1/auth/password/login')
      .send({ password: PASSWORD })
      .expect(200);
    const restartedCsrf = login.body.csrfToken as string;
    const history = await restartedAgent
      .get(`/api/v1/contributions/${contributionIds[0]}/revisions`)
      .expect(200);
    expect(
      history.body.items.map((item: { text: string }) => item.text),
    ).toEqual(['Morning reflection', 'Morning reflection, corrected']);
    await restartedAgent
      .get(`/api/v1/journal-days/${MOVED_DATE}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.contributions).toMatchObject([
          {
            id: contributionIds[1],
            capturedAt: '2026-08-16T11:00:00Z',
            capturedTimezone: 'America/New_York',
            journalTimezone: 'America/New_York',
            journalDateAssignment: 'user_override',
          },
        ]);
      });

    await restartedAgent
      .patch(`/api/v1/contributions/${contributionIds[0]}`)
      .set('idempotency-key', 'milestone-edit-after-restart')
      .set('if-match', '"revision-2"')
      .set('x-csrf-token', restartedCsrf)
      .send({
        revisionId: createUuidV7<'contribution-revision'>(),
        text: 'Morning reflection remains editable without AI',
      })
      .expect(200)
      .expect('etag', '"revision-3"');
  }, 120_000);
});
