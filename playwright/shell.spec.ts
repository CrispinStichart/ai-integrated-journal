import { expect, test, type Page } from '@playwright/test';

async function authenticateShell(page: Page) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/api/v1/auth/status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              bootstrapRequired: false,
              authenticated: true,
              displayName: 'Test owner',
              csrfToken: 'c'.repeat(43),
              sessionExpiresAt: '2026-08-17T12:00:00.000Z',
              passkeyCount: 1,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return originalFetch(input, init);
    };
  });
}

test('[ARCH-005][STATE-006] renders an accessible, navigable application shell', async ({
  page,
}) => {
  await authenticateShell(page);
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Today', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Settings', exact: true })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.locator('#main-content')).toBeFocused();
});

test('exposes an installable manifest and reloads the shell offline', async ({
  context,
  page,
}) => {
  await authenticateShell(page);
  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();

  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  await expect(manifest.json()).resolves.toMatchObject({
    display: 'standalone',
    name: 'Journal',
  });

  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});
