import { loadConfig } from '@journal/config';
import { createDatabaseClient, createQueueClient } from '@journal/database';
import { createContentSafeLogger } from '@journal/observability';

import { WorkerRuntime } from './worker.js';

const config = loadConfig();
const logger = createContentSafeLogger({
  level: config.logLevel,
  service: '@journal/worker',
});
const database = createDatabaseClient({ connectionString: config.databaseUrl });
const boss = createQueueClient(config.databaseUrl);
boss.on('error', (error: Error) => {
  logger.error({ errorType: error.name }, 'Queue runtime error');
});

const worker = new WorkerRuntime({ boss, database, logger });
await worker.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void worker.stop().catch((error: unknown) => {
      logger.fatal(
        { errorType: error instanceof Error ? error.name : 'UnknownError' },
        'Worker shutdown failed',
      );
      process.exitCode = 1;
    });
  });
}
