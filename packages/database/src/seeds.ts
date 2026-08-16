import type { ApplicationEnvironment } from './environment.js';
import type { JournalDatabase } from './client.js';
import {
  developmentFixtures,
  processorInstallations,
  queueConfigurations,
  schedules,
} from './schema.js';
import {
  allQueueDefinitions,
  createQueueJobPayload,
  queueNames,
} from './queue-contracts.js';
import { inTransaction } from './transaction.js';

const queueSeeds: (typeof queueConfigurations.$inferInsert)[] =
  allQueueDefinitions.map((definition) => ({
    deadLetterQueue: definition.queueOptions.deadLetter,
    expireInSeconds: definition.queueOptions.expireInSeconds ?? 15 * 60,
    name: definition.name,
    payloadSchemaVersion: definition.payloadSchemaVersion,
    retentionSeconds:
      definition.queueOptions.retentionSeconds ?? 14 * 24 * 60 * 60,
    retryBackoff: definition.queueOptions.retryBackoff ?? false,
    retryDelaySeconds: definition.queueOptions.retryDelay ?? 0,
    retryLimit: definition.queueOptions.retryLimit ?? 2,
  }));

const scheduleSeeds: (typeof schedules.$inferInsert)[] = [
  {
    key: 'retention.daily',
    queueName: queueNames.maintenance,
    cronExpression: '15 3 * * *',
    timeZone: 'UTC',
    payloadSchemaVersion: 1,
    payload: createQueueJobPayload({
      identifiers: { scheduleKey: 'retention.daily' },
      operation: 'retention',
      queueName: queueNames.maintenance,
    }),
    enabled: true,
  },
  {
    key: 'backup.daily',
    queueName: queueNames.backup,
    cronExpression: '30 3 * * *',
    timeZone: 'UTC',
    payloadSchemaVersion: 1,
    payload: createQueueJobPayload({
      identifiers: { scheduleKey: 'backup.daily' },
      operation: 'backup',
      queueName: queueNames.backup,
    }),
    enabled: false,
  },
  {
    key: 'nudges.digest',
    queueName: queueNames.notifications,
    cronExpression: '0 * * * *',
    timeZone: 'UTC',
    payloadSchemaVersion: 1,
    payload: createQueueJobPayload({
      identifiers: { scheduleKey: 'nudges.digest' },
      operation: 'nudge_digest',
      queueName: queueNames.notifications,
    }),
    enabled: true,
  },
];

const processorSeeds: (typeof processorInstallations.$inferInsert)[] = [
  {
    id: '019c5b90-0000-7000-8000-000000000001',
    key: 'food-and-drink',
    displayName: 'Food and drink',
  },
  {
    id: '019c5b90-0000-7000-8000-000000000002',
    key: 'mood',
    displayName: 'Mood',
  },
  {
    id: '019c5b90-0000-7000-8000-000000000003',
    key: 'sleep',
    displayName: 'Sleep',
  },
  {
    id: '019c5b90-0000-7000-8000-000000000004',
    key: 'tasks-and-intentions',
    displayName: 'Tasks and intentions',
  },
  {
    id: '019c5b90-0000-7000-8000-000000000005',
    key: 'summary',
    displayName: 'Summary',
  },
  {
    id: '019c5b90-0000-7000-8000-000000000006',
    key: 'accomplishments',
    displayName: 'Accomplishments',
  },
];

const developmentFixtureSeeds: (typeof developmentFixtures.$inferInsert)[] = [
  {
    key: 'synthetic-owner',
    fixtureType: 'owner',
    payloadSchemaVersion: 1,
    payload: {
      id: '019c5b90-0000-7000-8000-000000000101',
      timeZone: 'Etc/UTC',
    },
  },
  {
    key: 'synthetic-journal-day',
    fixtureType: 'journal-day',
    payloadSchemaVersion: 1,
    payload: {
      capturedAt: '2026-01-15T12:00:00.000Z',
      journalDate: '2026-01-15',
      ownerFixtureKey: 'synthetic-owner',
      text: 'Synthetic journal fixture sentence.',
    },
  },
];

export interface SeedDatabaseResult {
  readonly developmentFixturesRequested: number;
  readonly processorsRequested: number;
  readonly queuesRequested: number;
  readonly schedulesRequested: number;
}

/** Inserts immutable bootstrap defaults without overwriting operator changes. */
export async function seedDatabase(
  database: JournalDatabase,
  appEnvironment: ApplicationEnvironment,
): Promise<SeedDatabaseResult> {
  return inTransaction(database, async (transaction) => {
    await transaction
      .insert(queueConfigurations)
      .values(queueSeeds)
      .onConflictDoNothing();
    await transaction
      .insert(schedules)
      .values(scheduleSeeds)
      .onConflictDoNothing();
    await transaction
      .insert(processorInstallations)
      .values(processorSeeds)
      .onConflictDoNothing();

    const requestedDevelopmentFixtures =
      appEnvironment === 'development' ? developmentFixtureSeeds : [];
    if (requestedDevelopmentFixtures.length > 0) {
      await transaction
        .insert(developmentFixtures)
        .values(requestedDevelopmentFixtures)
        .onConflictDoNothing();
    }

    return Object.freeze({
      developmentFixturesRequested: requestedDevelopmentFixtures.length,
      processorsRequested: processorSeeds.length,
      queuesRequested: queueSeeds.length,
      schedulesRequested: scheduleSeeds.length,
    });
  });
}
