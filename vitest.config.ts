import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const workspacePackages = [
  'ai',
  'config',
  'contracts',
  'database',
  'domain',
  'observability',
  'processors',
  'storage',
  'test-support',
] as const;

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: Object.fromEntries([
      ...workspacePackages.map((packageName) => [
        `@journal/${packageName}`,
        path.join(repositoryRoot, 'packages', packageName, 'src', 'index.ts'),
      ]),
      [
        'virtual:pwa-register',
        path.join(
          repositoryRoot,
          'apps',
          'web',
          'test',
          'virtual-pwa-register.ts',
        ),
      ],
    ]),
  },
  test: {
    coverage: {
      exclude: [
        '**/*.d.ts',
        '**/*.config.{js,mjs,ts}',
        '**/main.ts',
        '**/src/vite-env.d.ts',
        // Journal repositories are exercised against real PostgreSQL in the
        // separately gated infrastructure suite; mocked SQL-chain coverage
        // would measure the mock rather than persistence behavior.
        'packages/database/src/repositories/journal-repository.ts',
        // The API journal service coordinates real Drizzle transactions and
        // durable idempotency; it is covered by the infrastructure suite.
        'apps/api/src/journal-service.ts',
        // Recording persistence coordinates real Drizzle transactions with
        // streamed blob I/O and is covered by the infrastructure suite.
        'apps/api/src/recording-service.ts',
        // Transcript inspection/editing coordinates exact revision locks,
        // dependency invalidation, and transactional queue jobs against real
        // PostgreSQL in the separately gated infrastructure suite.
        'apps/api/src/transcript-service.ts',
        // Processor publication coordinates immutable version graphs,
        // optimistic configuration updates, audit records, and idempotency in
        // real transactions; its rollback and persistence behavior is covered
        // by the separately gated Testcontainers integration suite.
        'apps/api/src/processor-service.ts',
        // Reprocessing planning resolves owner-scoped targets, exact immutable
        // versions, transactional queue insertion, progress, cancellation,
        // audit history, and idempotency against real PostgreSQL. Its behavior
        // is covered by the separately gated Testcontainers integration suite.
        'apps/api/src/reprocessing-service.ts',
        // Memory and feedback lifecycle policy uses owner-scoped polymorphic
        // target joins, append-only revisions, row/advisory locks, audit and
        // idempotency transactions. Real behavioral coverage lives in the
        // separately gated Testcontainers integration suite.
        'apps/api/src/memory-service.ts',
        'packages/database/src/memory-repository.ts',
        // Transcription coordinates PostgreSQL row locks, streamed immutable
        // blobs, provider ports, and queue attempts; the real-adapter contract
        // is covered by the infrastructure suite.
        'apps/worker/src/{raw-response-store,transcription-pipeline,transcript-cleanup-pipeline}.ts',
        'packages/database/src/{transcription-repository,transcript-cleanup-repository,transcript-evidence-repository}.ts',
        // Reconciliation depends on PostgreSQL advisory transaction locks and
        // database uniqueness constraints; its real concurrent behavior is
        // exercised by the separately gated Testcontainers integration suite.
        'packages/database/src/processor-reconciliation-repository.ts',
      ],
      include: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        branches: 75,
        functions: 80,
        lines: 80,
        statements: 80,
        'packages/{contracts,domain,processors,storage}/src/**': {
          branches: 85,
          functions: 90,
          lines: 90,
          statements: 90,
        },
      },
    },
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
  },
});
