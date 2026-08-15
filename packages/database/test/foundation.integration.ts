import { createPostgresTestContainer } from '@journal/test-support';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseClient,
  FoundationRepository,
  inTransaction,
  migrateDatabase,
  seedDatabase,
  type DatabaseClient,
} from '../src/index.js';
import { auditEvents, queueConfigurations } from '../src/schema.js';

describe('DB-JOURNAL foundation', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('migrates a clean database and remains compatible on repeated migration', async () => {
    await migrateDatabase(client.database);
    await seedDatabase(client.database, 'test');

    const before = await client.database.execute(
      sql`select count(*)::integer as count from journal.queue_configuration`,
    );
    await migrateDatabase(client.database);
    const after = await client.database.execute(
      sql`select count(*)::integer as count from journal.queue_configuration`,
    );

    expect(before.rows).toEqual([{ count: 5 }]);
    expect(after.rows).toEqual(before.rows);

    const fixtures = await client.database.execute(
      sql`select count(*)::integer as count from journal.development_fixture`,
    );
    expect(fixtures.rows).toEqual([{ count: 0 }]);
  });

  it('seeds queues, schedules, disabled optional processors, and dev fixtures idempotently', async () => {
    await seedDatabase(client.database, 'development');
    await seedDatabase(client.database, 'development');

    const repository = new FoundationRepository(client.database);
    const queues = await repository.listQueueConfigurations();
    const schedules = await repository.listSchedules();
    const processors = await repository.listProcessorInstallations();
    const fixtures = await client.database.execute(
      sql`select key from journal.development_fixture order by key`,
    );

    expect(queues).toHaveLength(5);
    expect(schedules).toHaveLength(3);
    expect(processors).toHaveLength(6);
    expect(processors.every(({ enabled }) => !enabled)).toBe(true);
    expect(
      processors.every(({ requirementMode }) => requirementMode === 'optional'),
    ).toBe(true);
    expect(fixtures.rows).toEqual([
      { key: 'synthetic-journal-day' },
      { key: 'synthetic-owner' },
    ]);
  });

  it('does not insert development fixtures in production or overwrite operator configuration', async () => {
    const fixturesBefore = await client.database.execute(
      sql`select count(*)::integer as count from journal.development_fixture`,
    );
    await client.database
      .update(queueConfigurations)
      .set({ retryLimit: 9 })
      .where(eq(queueConfigurations.name, 'journal.processing'));
    await seedDatabase(client.database, 'production');

    const [processingQueue] = await client.database
      .select({ retryLimit: queueConfigurations.retryLimit })
      .from(queueConfigurations)
      .where(eq(queueConfigurations.name, 'journal.processing'));

    expect(processingQueue).toEqual({ retryLimit: 9 });
    const fixturesAfter = await client.database.execute(
      sql`select count(*)::integer as count from journal.development_fixture`,
    );
    expect(fixturesAfter.rows).toEqual(fixturesBefore.rows);
  });

  it('[SEC-008] rolls repository and content-safe audit writes back atomically', async () => {
    const auditId = '019c5b90-0000-7000-8000-000000000201';
    const forcedRollback = new Error('forced rollback');

    await expect(
      inTransaction(client.database, async (transaction) => {
        await transaction.insert(auditEvents).values({
          id: auditId,
          action: 'database.test.rollback',
          entityType: 'database-test',
          correlationId: '019c5b90-0000-7000-8000-000000000202',
          metadata: { synthetic: true },
        });

        const repository = new FoundationRepository(transaction);
        expect(await repository.listQueueConfigurations()).toHaveLength(5);
        throw forcedRollback;
      }),
    ).rejects.toBe(forcedRollback);

    const persisted = await client.database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.id, auditId));
    expect(persisted).toEqual([]);
  });
});
