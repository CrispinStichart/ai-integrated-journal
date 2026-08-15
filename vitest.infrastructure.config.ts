import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/test-support/test/**/*.integration.ts'],
  },
});
