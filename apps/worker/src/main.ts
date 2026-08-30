import { loadConfig } from '@journal/config';
import { createDatabaseClient, createQueueClient } from '@journal/database';
import { createContentSafeLogger } from '@journal/observability';
import { AiProviderFactoryRegistry } from '@journal/ai';
import { LocalBlobStore } from '@journal/storage';

import { registerTranscriptionConsumer } from './transcription-pipeline.js';
import { registerTranscriptCleanupConsumer } from './transcript-cleanup-pipeline.js';
import { registerProcessorConsumer } from './processor-runtime.js';
import { registerNudgeDigestConsumer } from './nudge-engine.js';
import { registerSearchEmbeddingConsumer } from './search-embedding.js';
import { registerGroundedAnswerConsumer } from './grounded-answer.js';
import { registerRetentionConsumer } from './retention.js';
import { registerExportConsumer } from './export.js';
import { registerBackupConsumer } from './backup.js';
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
    await registerProcessorConsumer({
      boss: queue,
      database,
      blobs,
      resolveProvider: () =>
        providers.resolve(
          { providerId: 'unconfigured', enabled: false, settings: {} },
          'structured_generation',
        ),
    });
    await registerNudgeDigestConsumer({ boss: queue, database });
    await registerSearchEmbeddingConsumer({
      boss: queue,
      database,
      resolveProvider: () =>
        providers.resolve(
          { providerId: 'unconfigured', enabled: false, settings: {} },
          'embeddings',
        ),
    });
    await registerGroundedAnswerConsumer({
      boss: queue,
      database,
      blobs,
      resolveProvider: (canonical) =>
        providers.resolve(
          {
            providerId: String(
              canonical.answer.requestedConfiguration.providerId ??
                'unconfigured',
            ),
            enabled: false,
            settings: {},
          },
          'structured_generation',
        ),
    });
    await registerRetentionConsumer({
      boss: queue,
      database,
      blobs,
      backupConfigured: config.backup.configured,
    });
    await registerExportConsumer({ boss: queue, database, blobs });
    if (config.backup.configured) {
      await registerBackupConsumer({ boss: queue });
    }
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
