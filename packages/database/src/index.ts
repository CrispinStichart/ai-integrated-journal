/** Identifies the owning workspace package without exposing implementation paths. */
export const databasePackageName = '@journal/database' as const;

export {
  createDatabaseClient,
  type CreateDatabaseClientOptions,
  type DatabaseClient,
  type JournalDatabase,
  type JournalTransaction,
  type RepositoryContext,
} from './client.js';
export {
  parseDatabaseCommandEnvironment,
  type ApplicationEnvironment,
  type DatabaseCommandEnvironment,
} from './environment.js';
export { migrateDatabase, migrationsFolder } from './migrations.js';
export {
  FoundationRepository,
  type ProcessorInstallationRecord,
  type QueueConfigurationRecord,
  type ScheduleRecord,
} from './repositories/foundation-repository.js';
export { seedDatabase, type SeedDatabaseResult } from './seeds.js';
export { inTransaction, type TransactionWork } from './transaction.js';
export {
  allQueueDefinitions,
  createJobFingerprint,
  createQueueJobPayload,
  EXPECTED_PG_BOSS_SCHEMA_VERSION,
  InvalidQueuePayloadError,
  parseQueueJobPayload,
  QUEUE_PAYLOAD_SCHEMA_VERSION,
  queueDefinitions,
  queueNames,
  type QueueDefinition,
  type QueueJobPayload,
  type QueueName,
} from './queue-contracts.js';
export {
  assertQueueFoundation,
  cancelQueueJob,
  classifyQueueError,
  createQueueClient,
  enqueueJobInTransaction,
  provisionQueueFoundation,
  QueueFoundationError,
  QueueJobError,
  registerQueueWorker,
  type CanonicalJobHandler,
  type CanonicalJobInput,
  type QueueAttemptDisposition,
} from './queue-runtime.js';
