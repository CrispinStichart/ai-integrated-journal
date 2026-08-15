import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/database/test/**/*.integration.ts',
      'packages/test-support/test/**/*.integration.ts',
    ],
  },
});
