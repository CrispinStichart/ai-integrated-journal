import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@journal/domain': path.join(
        repositoryRoot,
        'packages/domain/src/index.ts',
      ),
    },
  },
  test: {
    include: [
      'packages/database/test/**/*.integration.ts',
      'packages/test-support/test/**/*.integration.ts',
    ],
  },
});
