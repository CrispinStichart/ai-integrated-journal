import { sql } from 'drizzle-orm';
import { fromDrizzle, type Job, PgBoss, type Queue } from 'pg-boss';

import type { DatabaseClient, JournalTransaction } from './client.js';
import {
  allQueueDefinitions,
  EXPECTED_PG_BOSS_SCHEMA_VERSION,
  parseQueueJobPayload,
  queueDefinitions,
  queueNames,
  type QueueJobPayload,
  type QueueName,
} from './queue-contracts.js';
import { FoundationRepository } from './repositories/foundation-repository.js';
import type { QueueConfigurationRecord } from './repositories/foundation-repository.js';

export class QueueFoundationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'QueueFoundationError';
  }
}

export function createQueueClient(
  connectionString: string,
  migrate = false,
): PgBoss {
  return new PgBoss({
    application_name: '@journal/queue',
    connectionString,
    migrate,
    schedule: true,
    supervise: true,
    useListenNotify: true,
  });
}

function persistedQueueOptions(
  queue: Queue,
): Readonly<Record<string, unknown>> {
  return {
    deadLetter: queue.deadLetter,
    deleteAfterSeconds: queue.deleteAfterSeconds,
    expireInSeconds: queue.expireInSeconds,
    heartbeatSeconds: queue.heartbeatSeconds,
    notify: queue.notify,
    retentionSeconds: queue.retentionSeconds,
    retryBackoff: queue.retryBackoff,
    retryDelay: queue.retryDelay,
    retryLimit: queue.retryLimit,
  };
}

function configuredQueueOptions(
  definition: (typeof allQueueDefinitions)[number],
  configuration: QueueConfigurationRecord,
): Readonly<Omit<Queue, 'name'>> {
  return {
    ...(configuration.deadLetterQueue === null
      ? {}
      : { deadLetter: configuration.deadLetterQueue }),
    deleteAfterSeconds: configuration.retentionSeconds,
    expireInSeconds: configuration.expireInSeconds,
    heartbeatSeconds: definition.queueOptions.heartbeatSeconds ?? 60,
    notify: definition.queueOptions.notify ?? true,
    retentionSeconds: configuration.retentionSeconds,
    retryBackoff: configuration.retryBackoff,
    retryDelay: configuration.retryDelaySeconds,
    retryLimit: configuration.retryLimit,
  };
}

/** Explicit deployment/seed operation; application processes never migrate pg-boss. */
export async function provisionQueueFoundation(
  boss: PgBoss,
  client: DatabaseClient,
): Promise<void> {
  await boss.start();
  const repository = new FoundationRepository(client.database);
  const configurations = await repository.listQueueConfigurations();
  const provisioningOrder = [
    queueDefinitions[queueNames.deadLetter],
    ...allQueueDefinitions.filter(({ name }) => name !== queueNames.deadLetter),
  ];
  for (const definition of provisioningOrder) {
    const configuration = configurations.find(
      ({ name }) => name === definition.name,
    );
    if (configuration === undefined) {
      throw new QueueFoundationError(
        `Queue configuration ${definition.name} is not seeded`,
      );
    }
    const queueOptions = configuredQueueOptions(definition, configuration);
    const existing = await boss.getQueue(definition.name);
    if (existing === null) {
      await boss.createQueue(definition.name, queueOptions);
    } else if (
      JSON.stringify(persistedQueueOptions(existing)) !==
      JSON.stringify(
        persistedQueueOptions({
          ...existing,
          ...queueOptions,
        }),
      )
    ) {
      await boss.updateQueue(definition.name, queueOptions);
    }
  }

  const schedules = await repository.listSchedules();
  for (const schedule of schedules) {
    if (schedule.enabled) {
      await boss.schedule(
        schedule.queueName,
        schedule.cronExpression,
        schedule.payload,
        { key: schedule.key, tz: schedule.timeZone },
      );
    } else {
      await boss.unschedule(schedule.queueName, schedule.key);
    }
  }
}

/** Fails startup when migrations, queue contracts, or pg-boss drift. */
export async function assertQueueFoundation(
  boss: PgBoss,
  client: DatabaseClient,
): Promise<void> {
  const migrationTable = await client.pool.query<{ name: string | null }>(
    "select to_regclass('journal_migrations.__drizzle_migrations')::text as name",
  );
  if (!migrationTable.rows[0]?.name) {
    throw new QueueFoundationError('Application migrations are not installed');
  }
  if (!(await boss.isInstalled())) {
    throw new QueueFoundationError('pg-boss schema is not installed');
  }
  const schemaVersion = await boss.schemaVersion();
  if (schemaVersion !== EXPECTED_PG_BOSS_SCHEMA_VERSION) {
    throw new QueueFoundationError(
      `pg-boss schema version ${String(schemaVersion)} does not match expected ${EXPECTED_PG_BOSS_SCHEMA_VERSION}`,
    );
  }

  const configurations = await new FoundationRepository(
    client.database,
  ).listQueueConfigurations();
  for (const definition of allQueueDefinitions) {
    const configuration = configurations.find(
      ({ name }) => name === definition.name,
    );
    const installedQueue = await boss.getQueue(definition.name);
    const optionsCompatible =
      configuration !== undefined &&
      installedQueue !== null &&
      JSON.stringify(persistedQueueOptions(installedQueue)) ===
        JSON.stringify(
          persistedQueueOptions({
            ...installedQueue,
            ...configuredQueueOptions(definition, configuration),
          }),
        );
    if (
      configuration?.payloadSchemaVersion !== definition.payloadSchemaVersion ||
      !optionsCompatible
    ) {
      throw new QueueFoundationError(
        `Queue ${definition.name} is missing or schema-incompatible`,
      );
    }
  }
}

export async function enqueueJobInTransaction(input: {
  readonly boss: PgBoss;
  readonly jobId: string;
  readonly payload: QueueJobPayload;
  readonly queueName: QueueName;
  readonly transaction: JournalTransaction;
}): Promise<string> {
  parseQueueJobPayload(input.queueName, input.payload);
  const insertedId = await input.boss.send(input.queueName, input.payload, {
    db: fromDrizzle(input.transaction, sql),
    id: input.jobId,
  });
  if (insertedId === null) {
    throw new QueueFoundationError('Queue rejected the transactional job');
  }
  return insertedId;
}

export type QueueAttemptDisposition = 'canceled' | 'permanent' | 'transient';

export class QueueJobError extends Error {
  public constructor(
    public readonly disposition: QueueAttemptDisposition,
    message: string,
  ) {
    super(message);
    this.name = 'QueueJobError';
  }
}

export function classifyQueueError(error: unknown): QueueAttemptDisposition {
  if (error instanceof QueueJobError) return error.disposition;
  return 'transient';
}

export interface CanonicalJobInput<Input> {
  readonly input?: Input;
  readonly state: 'already-complete' | 'canceled' | 'runnable';
}

export interface CanonicalJobHandler<Input> {
  execute(input: Input, signal: AbortSignal): Promise<void>;
  load(payload: QueueJobPayload): Promise<CanonicalJobInput<Input>>;
}

/**
 * Registers an identifier-only consumer. Every attempt reloads canonical state;
 * pg-boss heartbeats and expiration recover work abandoned by a crashed process.
 */
export async function registerQueueWorker<Input>(input: {
  readonly boss: PgBoss;
  readonly handler: CanonicalJobHandler<Input>;
  readonly queueName: Exclude<QueueName, 'journal.dead-letter'>;
}): Promise<string> {
  const definition = queueDefinitions[input.queueName];
  const workOptions = {
    ...definition.workOptions,
    includeMetadata: false,
    perJobResults: true,
  } as const;
  return input.boss.work<
    QueueJobPayload,
    Readonly<{ code: string }>,
    typeof workOptions
  >(input.queueName, workOptions, async (jobs: Job<QueueJobPayload>[]) =>
    Promise.all(
      jobs.map(async (job) => {
        try {
          const payload = parseQueueJobPayload(input.queueName, job.data);
          const canonical = await input.handler.load(payload);
          if (
            canonical.state === 'canceled' ||
            canonical.state === 'already-complete' ||
            job.signal.aborted
          ) {
            return {
              id: job.id,
              output: { code: canonical.state },
              status: 'completed' as const,
            };
          }
          if (canonical.input === undefined) {
            throw new QueueJobError(
              'permanent',
              'Runnable canonical job input is missing',
            );
          }
          await input.handler.execute(canonical.input, job.signal);
          return {
            id: job.id,
            output: { code: 'succeeded' },
            status: 'completed' as const,
          };
        } catch (error: unknown) {
          const disposition = classifyQueueError(error);
          if (disposition === 'canceled') {
            return {
              id: job.id,
              output: { code: 'canceled' },
              status: 'completed' as const,
            };
          }
          return {
            id: job.id,
            output: {
              code:
                disposition === 'permanent'
                  ? 'permanent_failure'
                  : 'transient_failure',
            },
            status:
              disposition === 'permanent'
                ? ('deadletter' as const)
                : ('failed' as const),
          };
        }
      }),
    ),
  );
}

export async function cancelQueueJob(
  boss: PgBoss,
  queueName: QueueName,
  jobId: string,
): Promise<void> {
  await boss.cancel(queueName, jobId);
}
