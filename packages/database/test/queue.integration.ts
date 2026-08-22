import { createPostgresTestContainer } from '@journal/test-support';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertQueueFoundation,
  createDatabaseClient,
  createQueueClient,
  createQueueJobPayload,
  enqueueJobInTransaction,
  inTransaction,
  migrateDatabase,
  provisionQueueFoundation,
  QueueJobError,
  queueNames,
  registerQueueWorker,
  seedDatabase,
  type DatabaseClient,
} from '../src/index.js';
import { auditEvents } from '../src/schema.js';

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await condition())) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for queue state');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

describe('WORKER pg-boss foundation', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let boss: PgBoss;

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
    await seedDatabase(client.database, 'test');
    boss = createQueueClient(container.getConnectionUri(), true);
    await provisionQueueFoundation(boss, client);
  }, 120_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await client?.close();
    await container?.stop();
  });

  it('[STATE-001] provisions compatible queues, heartbeats, dead-letter policy, and enabled schedules idempotently', async () => {
    await provisionQueueFoundation(boss, client);
    await assertQueueFoundation(boss, client);

    const queues = await boss.getQueues();
    const schedules = await boss.getSchedules();
    expect(
      queues
        .map(({ name }) => name)
        .filter((name) => name.startsWith('journal.'))
        .sort(),
    ).toEqual(Object.values(queueNames).sort());
    expect(
      queues.find(({ name }) => name === queueNames.processing),
    ).toMatchObject({
      deadLetter: queueNames.deadLetter,
      heartbeatSeconds: 60,
      retryLimit: 5,
    });
    expect(schedules.map(({ key }) => key).sort()).toEqual([
      'nudges.digest',
      'retention.daily',
    ]);
  });

  it('[STATE-004][STATE-006] atomically commits or rolls back canonical state with its deterministic job', async () => {
    const committedAuditId = '019c5b90-0000-7000-8000-000000000301';
    const committedJobId = '019c5b90-0000-7000-8000-000000000302';
    const rolledBackAuditId = '019c5b90-0000-7000-8000-000000000303';
    const rolledBackJobId = '019c5b90-0000-7000-8000-000000000304';
    const payload = createQueueJobPayload({
      identifiers: { runId: committedAuditId },
      operation: 'synthetic_processing',
      queueName: queueNames.processing,
    });

    await inTransaction(client.database, async (transaction) => {
      await transaction.insert(auditEvents).values({
        action: 'queue.test.commit',
        correlationId: committedAuditId,
        entityType: 'synthetic-run',
        id: committedAuditId,
      });
      expect(
        await enqueueJobInTransaction({
          boss,
          jobId: committedJobId,
          payload,
          queueName: queueNames.processing,
          transaction,
        }),
      ).toBe(committedJobId);
    });

    await expect(
      inTransaction(client.database, async (transaction) => {
        await transaction.insert(auditEvents).values({
          action: 'queue.test.rollback',
          correlationId: rolledBackAuditId,
          entityType: 'synthetic-run',
          id: rolledBackAuditId,
        });
        await enqueueJobInTransaction({
          boss,
          jobId: rolledBackJobId,
          payload: createQueueJobPayload({
            identifiers: { runId: rolledBackAuditId },
            operation: 'synthetic_processing',
            queueName: queueNames.processing,
          }),
          queueName: queueNames.processing,
          transaction,
        });
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const rows = await client.database.execute(sql`
      select id from journal.audit_event
      where id in (${committedAuditId}::uuid, ${rolledBackAuditId}::uuid)
      order by id
    `);
    expect(rows.rows).toEqual([{ id: committedAuditId }]);
    expect(
      await boss.getJobById(queueNames.processing, committedJobId),
    ).not.toBeNull();
    expect(
      await boss.getJobById(queueNames.processing, rolledBackJobId),
    ).toBeNull();
  });

  it('[STATE-003][STATE-004] recovers an expired job claimed by a crashed worker', async () => {
    const jobId = '019c5b90-0000-7000-8000-000000000305';
    await boss.send(
      queueNames.backup,
      createQueueJobPayload({
        identifiers: { runId: jobId },
        operation: 'synthetic_crash_recovery',
        queueName: queueNames.backup,
      }),
      { expireInSeconds: 1, id: jobId, retryDelay: 0 },
    );
    const claimed = await boss.fetch(queueNames.backup);
    expect(claimed.map(({ id }) => id)).toContain(jobId);

    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    await boss.supervise(queueNames.backup);
    await waitFor(async () => {
      const recovered = await boss.getJobById(queueNames.backup, jobId);
      return recovered?.state === 'retry' || recovered?.state === 'created';
    }, 20_000);
  }, 30_000);

  it('[STATE-001] supports durable cancellation before execution', async () => {
    const jobId = '019c5b90-0000-7000-8000-000000000306';
    await boss.send(
      queueNames.notifications,
      createQueueJobPayload({
        identifiers: { runId: jobId },
        operation: 'synthetic_cancel',
        queueName: queueNames.notifications,
      }),
      { id: jobId, startAfter: 60 },
    );
    await boss.cancel(queueNames.notifications, jobId);
    expect(
      (await boss.getJobById(queueNames.notifications, jobId))?.state,
    ).toBe('cancelled');
  });

  it('[STATE-003][STATE-004] reloads canonical input, retries transient failures, and dead-letters permanent failures', async () => {
    const transientJobId = '019c5b90-0000-7000-8000-000000000307';
    const permanentJobId = '019c5b90-0000-7000-8000-000000000308';
    const canceledJobId = '019c5b90-0000-7000-8000-000000000309';
    const loads = new Map<string, number>();
    const workerId = await registerQueueWorker({
      boss,
      handler: {
        load: async (payload) => {
          loads.set(payload.operation, (loads.get(payload.operation) ?? 0) + 1);
          if (payload.operation === 'synthetic_canonical_cancel') {
            return { state: 'canceled' as const };
          }
          return { input: payload.operation, state: 'runnable' as const };
        },
        execute: async (operation) => {
          if (
            operation === 'synthetic_transient' &&
            loads.get(operation) === 1
          ) {
            throw new Error('synthetic transient failure');
          }
          if (operation === 'synthetic_permanent') {
            throw new QueueJobError('permanent', 'synthetic permanent failure');
          }
        },
      },
      queueName: queueNames.maintenance,
    });

    const sendSyntheticJob = async (jobId: string, operation: string) => {
      await boss.send(
        queueNames.maintenance,
        createQueueJobPayload({
          identifiers: { runId: jobId },
          operation,
          queueName: queueNames.maintenance,
        }),
        { id: jobId, retryDelay: 0, retryLimit: 1 },
      );
      boss.notifyWorker(workerId);
    };

    await sendSyntheticJob(transientJobId, 'synthetic_transient');
    await waitFor(async () => {
      const job = await boss.getJobById(queueNames.maintenance, transientJobId);
      return job?.state === 'retry';
    });
    await waitFor(async () => {
      const job = await boss.getJobById(queueNames.maintenance, transientJobId);
      return job?.state === 'completed';
    });

    await sendSyntheticJob(permanentJobId, 'synthetic_permanent');
    await waitFor(async () => {
      const job = await boss.getJobById(queueNames.maintenance, permanentJobId);
      return job?.state === 'failed';
    });

    await sendSyntheticJob(canceledJobId, 'synthetic_canonical_cancel');
    await waitFor(async () => {
      const job = await boss.getJobById(queueNames.maintenance, canceledJobId);
      return job?.state === 'completed';
    });
    const deadLetters = await boss.findJobs(queueNames.deadLetter);
    expect(
      deadLetters.some(({ sourceId }) => sourceId === permanentJobId),
    ).toBe(true);
    expect(loads.get('synthetic_transient')).toBe(2);
    expect(loads.get('synthetic_canonical_cancel')).toBe(1);
    await boss.offWork(queueNames.maintenance, { wait: true });
  }, 30_000);
});
