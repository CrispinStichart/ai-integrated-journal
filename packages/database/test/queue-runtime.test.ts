import type { PgBoss, Queue } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repositoryState = vi.hoisted(() => ({
  queues: [] as Readonly<Record<string, unknown>>[],
  schedules: [] as Readonly<Record<string, unknown>>[],
}));

vi.mock('../src/repositories/foundation-repository.js', () => ({
  FoundationRepository: class {
    public listQueueConfigurations() {
      return Promise.resolve(repositoryState.queues);
    }

    public listSchedules() {
      return Promise.resolve(repositoryState.schedules);
    }
  },
}));

import {
  allQueueDefinitions,
  createQueueJobPayload,
  queueNames,
} from '../src/queue-contracts.js';
import {
  assertQueueFoundation,
  cancelQueueJob,
  createQueueClient,
  enqueueJobInTransaction,
  provisionQueueFoundation,
  QueueFoundationError,
  QueueJobError,
  registerQueueWorker,
} from '../src/queue-runtime.js';
import type { DatabaseClient, JournalTransaction } from '../src/client.js';

function queueConfiguration(name: string) {
  const definition = allQueueDefinitions.find((item) => item.name === name);
  if (definition === undefined) throw new Error('missing test definition');
  return {
    deadLetterQueue: definition.queueOptions.deadLetter ?? null,
    expireInSeconds: definition.queueOptions.expireInSeconds,
    name,
    payloadSchemaVersion: definition.payloadSchemaVersion,
    retentionSeconds: definition.queueOptions.retentionSeconds,
    retryBackoff: definition.queueOptions.retryBackoff,
    retryDelaySeconds: definition.queueOptions.retryDelay,
    retryLimit: definition.queueOptions.retryLimit,
  };
}

function installedQueue(name: string): Queue {
  const configuration = queueConfiguration(name);
  return {
    activeCount: 0,
    completedCount: 0,
    createdOn: new Date(0),
    deadLetter: configuration.deadLetterQueue ?? undefined,
    deferredCount: 0,
    deleteAfterSeconds: configuration.retentionSeconds,
    expireInSeconds: configuration.expireInSeconds,
    failedCount: 0,
    heartbeatSeconds: 60,
    name,
    notify: true,
    policy: 'standard',
    queuedCount: 0,
    readyCount: 0,
    retentionSeconds: configuration.retentionSeconds,
    retryBackoff: configuration.retryBackoff,
    retryDelay: configuration.retryDelaySeconds,
    retryLimit: configuration.retryLimit,
    retryCount: 0,
    singletonCount: 0,
    totalCount: 0,
    updatedOn: new Date(0),
  } as unknown as Queue;
}

function databaseClient(
  migrationName = 'journal_migrations.__drizzle_migrations',
) {
  return {
    close: vi.fn(),
    database: {},
    pool: {
      query: vi.fn().mockResolvedValue({ rows: [{ name: migrationName }] }),
    },
  } as unknown as DatabaseClient;
}

describe('WORKER queue runtime boundaries', () => {
  beforeEach(() => {
    repositoryState.queues = Object.values(queueNames).map(queueConfiguration);
    repositoryState.schedules = [
      {
        cronExpression: '0 * * * *',
        enabled: true,
        key: 'enabled.schedule',
        payload: {},
        queueName: queueNames.maintenance,
        timeZone: 'UTC',
      },
      {
        cronExpression: '0 0 * * *',
        enabled: false,
        key: 'disabled.schedule',
        payload: {},
        queueName: queueNames.backup,
        timeZone: 'UTC',
      },
    ];
  });

  it('constructs a non-migrating client and provisions missing queues and schedules', async () => {
    expect(createQueueClient('postgresql://localhost/journal')).toBeInstanceOf(
      Object,
    );
    const boss = {
      createQueue: vi.fn(),
      getQueue: vi.fn().mockResolvedValue(null),
      schedule: vi.fn(),
      start: vi.fn(),
      unschedule: vi.fn(),
      updateQueue: vi.fn(),
    } as unknown as PgBoss;

    await provisionQueueFoundation(boss, databaseClient());

    expect(boss.createQueue).toHaveBeenCalledTimes(5);
    expect(boss.schedule).toHaveBeenCalledWith(
      queueNames.maintenance,
      '0 * * * *',
      {},
      { key: 'enabled.schedule', tz: 'UTC' },
    );
    expect(boss.unschedule).toHaveBeenCalledWith(
      queueNames.backup,
      'disabled.schedule',
    );
  });

  it('reconciles drift and rejects an unseeded queue', async () => {
    const boss = {
      createQueue: vi.fn(),
      getQueue: vi.fn().mockResolvedValue({
        ...installedQueue(queueNames.processing),
        retryLimit: 99,
      }),
      schedule: vi.fn(),
      start: vi.fn(),
      unschedule: vi.fn(),
      updateQueue: vi.fn(),
    } as unknown as PgBoss;
    await provisionQueueFoundation(boss, databaseClient());
    expect(boss.updateQueue).toHaveBeenCalled();

    repositoryState.queues = repositoryState.queues.slice(1);
    await expect(
      provisionQueueFoundation(boss, databaseClient()),
    ).rejects.toThrow(QueueFoundationError);
  });

  it('accepts compatible schemas and rejects missing application or queue schemas', async () => {
    const boss = {
      getQueue: vi.fn((name: string) => Promise.resolve(installedQueue(name))),
      isInstalled: vi.fn().mockResolvedValue(true),
      schemaVersion: vi.fn().mockResolvedValue(37),
    } as unknown as PgBoss;
    await expect(
      assertQueueFoundation(boss, databaseClient()),
    ).resolves.toBeUndefined();
    await expect(
      assertQueueFoundation(boss, databaseClient('')),
    ).rejects.toThrow('Application migrations');

    vi.mocked(boss.isInstalled).mockResolvedValue(false);
    await expect(assertQueueFoundation(boss, databaseClient())).rejects.toThrow(
      'pg-boss schema is not installed',
    );
    vi.mocked(boss.isInstalled).mockResolvedValue(true);
    vi.mocked(boss.schemaVersion).mockResolvedValue(36);
    await expect(assertQueueFoundation(boss, databaseClient())).rejects.toThrow(
      'does not match expected',
    );
  });

  it('[STATE-004] sends through the transaction adapter and rejects a null insertion', async () => {
    const payload = createQueueJobPayload({
      identifiers: { runId: 'run-1' },
      operation: 'test',
      queueName: queueNames.processing,
    });
    const boss = {
      send: vi.fn().mockResolvedValue('job-1'),
    } as unknown as PgBoss;
    const input = {
      boss,
      jobId: 'job-1',
      payload,
      queueName: queueNames.processing,
      transaction: {} as JournalTransaction,
    } as const;
    await expect(enqueueJobInTransaction(input)).resolves.toBe('job-1');
    vi.mocked(boss.send).mockResolvedValue(null);
    await expect(enqueueJobInTransaction(input)).rejects.toThrow(
      'rejected the transactional job',
    );
  });

  it('[STATE-003] settles success, canonical no-ops, cancellation, transient retry, and permanent dead-letter outcomes', async () => {
    let callback:
      | ((jobs: Readonly<Record<string, unknown>>[]) => Promise<unknown>)
      | undefined;
    const boss = {
      work: vi.fn(
        (_name: string, _options: unknown, handler: typeof callback) => {
          callback = handler;
          return Promise.resolve('worker-1');
        },
      ),
    } as unknown as PgBoss;
    const workerId = await registerQueueWorker({
      boss,
      handler: {
        load: async (payload) => {
          if (payload.operation === 'complete')
            return { state: 'already-complete' as const };
          if (payload.operation === 'canonical-cancel')
            return { state: 'canceled' as const };
          if (payload.operation === 'missing')
            return { state: 'runnable' as const };
          return { input: payload.operation, state: 'runnable' as const };
        },
        execute: async (operation) => {
          if (operation === 'transient') throw new Error('temporary');
          if (operation === 'permanent')
            throw new QueueJobError('permanent', 'invalid');
          if (operation === 'throw-cancel')
            throw new QueueJobError('canceled', 'canceled');
        },
      },
      queueName: queueNames.processing,
    });
    expect(workerId).toBe('worker-1');

    const operations = [
      'success',
      'complete',
      'canonical-cancel',
      'missing',
      'transient',
      'permanent',
      'throw-cancel',
    ];
    const jobs = operations.map((operation, index) => ({
      data: createQueueJobPayload({
        identifiers: { runId: `run-${String(index)}` },
        operation,
        queueName: queueNames.processing,
      }),
      id: `job-${String(index)}`,
      signal: new AbortController().signal,
    }));
    const results = (await callback?.(jobs)) as ReadonlyArray<{
      status: string;
    }>;
    expect(results.map(({ status }) => status)).toEqual([
      'completed',
      'completed',
      'completed',
      'deadletter',
      'failed',
      'deadletter',
      'completed',
    ]);
  });

  it('delegates durable cancellation to pg-boss', async () => {
    const boss = { cancel: vi.fn() } as unknown as PgBoss;
    await cancelQueueJob(boss, queueNames.processing, 'job-1');
    expect(boss.cancel).toHaveBeenCalledWith(queueNames.processing, 'job-1');
  });
});
