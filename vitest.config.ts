import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

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
  resolve: {
    alias: Object.fromEntries(
      workspacePackages.map((packageName) => [
        `@journal/${packageName}`,
        path.join(repositoryRoot, 'packages', packageName, 'src', 'index.ts'),
      ]),
    ),
  },
  test: {
    coverage: {
      exclude: [
        '**/*.d.ts',
        '**/*.config.{js,mjs,ts}',
        '**/main.ts',
        '**/src/vite-env.d.ts',
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
