import { constants } from 'node:fs';
import { access } from 'node:fs/promises';

import { loadConfig } from '@journal/config';
import { createDatabaseClient } from '@journal/database';
import { createContentSafeLogger } from '@journal/observability';

import { createApiApp } from './app.js';
import { createInMemoryEventFeed } from './events.js';
import { createGracefulShutdown } from './shutdown.js';
import type { HealthProbe } from './types.js';

const config = loadConfig();
const logger = createContentSafeLogger({
  level: config.logLevel,
  service: '@journal/api',
});
const database = createDatabaseClient({ connectionString: config.databaseUrl });

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
        "select to_regclass('drizzle.__drizzle_migrations')::text as migrations",
      );
      return result.rows[0]?.migrations
        ? { status: 'healthy' }
        : { status: 'unhealthy', detail: 'migrations_not_applied' };
    },
  },
  {
    name: 'queue',
    requiredForReadiness: false,
    check: async () => ({ status: 'not_configured', detail: 'task_13' }),
  },
  {
    name: 'providers',
    requiredForReadiness: false,
    check: async () => ({ status: 'not_configured' }),
  },
];

const app = createApiApp({
  authenticator: {
    authenticate: async () => undefined,
  },
  eventFeed: createInMemoryEventFeed(),
  healthProbes,
  logger,
});
const server = app.listen(config.http.port, config.http.host, () => {
  logger.info(
    { host: config.http.host, port: config.http.port },
    'API listening',
  );
});
const shutdown = createGracefulShutdown({
  logger,
  resources: [{ close: () => database.close() }],
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
