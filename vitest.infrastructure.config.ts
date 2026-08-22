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
    include: [
      'packages/database/test/**/*.integration.ts',
      'packages/test-support/test/**/*.integration.ts',
      'apps/api/test/**/*.integration.ts',
    ],
  },
});
