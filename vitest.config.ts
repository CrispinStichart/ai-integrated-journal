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
        // Transcription coordinates PostgreSQL row locks, streamed immutable
        // blobs, provider ports, and queue attempts; the real-adapter contract
        // is covered by the infrastructure suite.
        'apps/worker/src/{raw-response-store,transcription-pipeline}.ts',
        'packages/database/src/transcription-repository.ts',
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
