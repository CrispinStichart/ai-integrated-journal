import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './playwright',
  outputDir: 'test-results/playwright',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'corepack pnpm --filter @journal/web preview --host 127.0.0.1',
    reuseExistingServer: !process.env.CI,
    url: 'http://127.0.0.1:4173',
  },
  projects: [
    {
      name: 'firefox',
      testIgnore: /task-54-mobile\.spec\.ts/u,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'firefox-mobile-viewport',
      testMatch: /task-54-mobile\.spec\.ts/u,
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 360, height: 740 },
        hasTouch: true,
      },
    },
  ],
});
