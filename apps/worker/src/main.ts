import { loadConfig } from '@journal/config';
import { createDatabaseClient, createQueueClient } from '@journal/database';
import { createContentSafeLogger } from '@journal/observability';
import { AiProviderFactoryRegistry } from '@journal/ai';
import { LocalBlobStore } from '@journal/storage';

import { registerTranscriptionConsumer } from './transcription-pipeline.js';
import { registerTranscriptCleanupConsumer } from './transcript-cleanup-pipeline.js';
import { WorkerRuntime } from './worker.js';

const config = loadConfig();
const logger = createContentSafeLogger({
  level: config.logLevel,
  service: '@journal/worker',
});
const database = createDatabaseClient({ connectionString: config.databaseUrl });
const boss = createQueueClient(config.databaseUrl);
const providers = new AiProviderFactoryRegistry();
const blobs = new LocalBlobStore(config.blobDataDirectory);
boss.on('error', (error: Error) => {
  logger.error({ errorType: error.name }, 'Queue runtime error');
});

const worker = new WorkerRuntime({
  boss,
  database,
  logger,
  registerConsumers: async (queue) => {
    await registerTranscriptionConsumer({
      boss: queue,
      database,
      blobs,
      resolveProvider: () =>
        providers.resolve(
          { providerId: 'unconfigured', enabled: false, settings: {} },
          'speech_to_text',
        ),
    });
    await registerTranscriptCleanupConsumer({
      boss: queue,
      database,
      blobs,
      resolveProvider: () =>
        providers.resolve(
          { providerId: 'unconfigured', enabled: false, settings: {} },
          'structured_generation',
        ),
    });
  },
});
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
