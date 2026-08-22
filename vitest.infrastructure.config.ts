import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      [
        'contracts',
        'database',
        'domain',
        'observability',
        'storage',
        'test-support',
      ].map((packageName) => [
        `@journal/${packageName}`,
        path.join(repositoryRoot, 'packages', packageName, 'src/index.ts'),
      ]),
    ),
  },
  test: {
    // Testcontainers compete for the same Docker daemon and can pause or stop
    // sibling containers when the integration files start in parallel.
    fileParallelism: false,
    maxWorkers: 1,
    include: [
      'packages/database/test/**/*.integration.ts',
      'packages/test-support/test/**/*.integration.ts',
      'apps/api/test/**/*.integration.ts',
    ],
  },
});
