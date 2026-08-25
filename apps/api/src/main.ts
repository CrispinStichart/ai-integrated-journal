import { constants } from 'node:fs';
import { access } from 'node:fs/promises';

import { loadConfig } from '@journal/config';
import {
  assertQueueFoundation,
  createDatabaseClient,
  createQueueClient,
} from '@journal/database';
import { createContentSafeLogger } from '@journal/observability';
import { LocalBlobStore } from '@journal/storage';

import { createApiApp } from './app.js';
import { AuthenticationService } from './auth.js';
import { createPostgresAuthenticationStore as createAuthStore } from './auth-store.js';
import { createInMemoryEventFeed } from './events.js';
import { PostgresNudgeService } from './nudge-service.js';
import { createGracefulShutdown } from './shutdown.js';
import type { HealthProbe } from './types.js';
import { PostgresJournalService } from './journal-service.js';
import { PostgresRecordingService } from './recording-service.js';
import { PostgresProcessorService } from './processor-service.js';
import { PostgresReprocessingService } from './reprocessing-service.js';
import { PostgresTranscriptService } from './transcript-service.js';
import { PostgresArtifactService } from './artifact-service.js';
import { PostgresMemoryService } from './memory-service.js';
import { PostgresSearchService } from './search-service.js';

const config = loadConfig();
const logger = createContentSafeLogger({
  level: config.logLevel,
  service: '@journal/api',
});
const database = createDatabaseClient({ connectionString: config.databaseUrl });
const boss = createQueueClient(config.databaseUrl);
boss.on('error', (error: Error) => {
  logger.error({ errorType: error.name }, 'Queue runtime error');
});
await boss.start();
await assertQueueFoundation(boss, database);

const healthProbes: readonly HealthProbe[] = [
  {
    name: 'postgresql',
    requiredForReadiness: true,
    check: async () => {
      await database.pool.query('select 1');
      return { status: 'healthy' };
    },
  },
  {
    name: 'storage',
    requiredForReadiness: true,
    check: async () => {
      await access(config.blobDataDirectory, constants.R_OK | constants.W_OK);
      return { status: 'healthy' };
    },
  },
  {
    name: 'migrations',
    requiredForReadiness: false,
    check: async () => {
      const result = await database.pool.query<{ migrations: string | null }>(
        "select to_regclass('journal_migrations.__drizzle_migrations')::text as migrations",
      );
      return result.rows[0]?.migrations
        ? { status: 'healthy' }
        : { status: 'unhealthy', detail: 'migrations_not_applied' };
    },
  },
  {
    name: 'queue',
    requiredForReadiness: false,
    check: async () => {
      const schemaVersion = await boss.schemaVersion();
      const queues = await boss.getQueues();
      return {
        status: 'healthy',
        detail: `schema_${String(schemaVersion)}_queues_${queues.length}`,
      };
    },
  },
  {
    name: 'providers',
    requiredForReadiness: false,
    check: async () => ({ status: 'not_configured' }),
  },
];

const authenticationService = new AuthenticationService({
  store: createAuthStore(database.database),
  rpId: config.auth.rpId,
  expectedOrigin: config.auth.expectedOrigin,
  secureCookies: config.auth.secureCookies,
});

const eventFeed = createInMemoryEventFeed();
const app = createApiApp({
  artifactService: new PostgresArtifactService(database.database),
  authenticator: authenticationService,
  authenticationService,
  eventFeed,
  healthProbes,
  logger,
  journalService: new PostgresJournalService(
    database.database,
    undefined,
    boss,
  ),
  memoryService: new PostgresMemoryService(database.database),
  nudgeService: new PostgresNudgeService(database.database, (ownerId, event) =>
    eventFeed.publish(ownerId, event),
  ),
  recordingService: new PostgresRecordingService(
    database.database,
    new LocalBlobStore(config.blobDataDirectory),
    boss,
  ),
  processorService: new PostgresProcessorService(database.database),
  reprocessingService: new PostgresReprocessingService(database.database, boss),
  searchService: new PostgresSearchService(database.database),
  transcriptService: new PostgresTranscriptService(database.database, boss),
});
const server = app.listen(config.http.port, config.http.host, () => {
  logger.info(
    { host: config.http.host, port: config.http.port },
    'API listening',
  );
});
const shutdown = createGracefulShutdown({
  logger,
  resources: [
    { close: () => database.close() },
    {
      close: () => boss.stop({ graceful: true, timeout: 10_000 }),
    },
  ],
  server,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().catch((error: unknown) => {
      logger.fatal(
        { errorType: error instanceof Error ? error.name : 'UnknownError' },
        'API shutdown failed',
      );
      process.exitCode = 1;
    });
  });
}
