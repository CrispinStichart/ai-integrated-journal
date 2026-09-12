import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const OWNER_ID = '018f0000-0000-7000-8000-000000000001';

async function prepareShell(page: Page): Promise<void> {
  await page.addInitScript((ownerId) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/api/v1/auth/status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              bootstrapRequired: false,
              authenticated: true,
              ownerId,
              displayName: 'Accessibility test owner',
              csrfToken: 'c'.repeat(43),
              sessionExpiresAt: '2040-01-01T12:00:00.000Z',
              passkeyCount: 1,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (url.includes('/api/v1/retention/tombstones')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ items: [], latestGeneration: 0, hasMore: false }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return originalFetch(input, init);
    };
  }, OWNER_ID);
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Synthetic offline dependency',
        status: 503,
        detail: 'Unavailable in the accessibility fixture.',
        code: 'test_unavailable',
      }),
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await prepareShell(page);
});

test('[ARCH-005][STATE-006] supports keyboard-only mobile navigation, skip focus, and route focus', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Today', exact: true }),
  ).toBeVisible();

  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to content' });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  const openNavigation = page.getByRole('button', { name: 'Open navigation' });
  await openNavigation.focus();
  await page.keyboard.press('Enter');
  await expect(openNavigation).toHaveAttribute('aria-expanded', 'true');
  await page
    .getByRole('navigation', { name: 'Application sections' })
    .getByRole('link', { name: 'Settings' })
    .click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.locator('#main-content')).toBeFocused();
});

test('[ARCH-005] has screen-reader semantics, WCAG 2.2 AA axe results, reflow, and reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');

  await expect(page.getByRole('main')).toHaveAttribute('tabindex', '-1');
  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }),
  ).toBeVisible();
  await expect(
    page.getByRole('status', { name: 'The browser reports network access' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .getByRole('button', { name: 'Open navigation' })
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toMatch(/^(0s|0\.00001s)(, (0s|0\.00001s))*$/u);

  await page.addScriptTag({
    path: path.resolve('apps/web/node_modules/axe-core/axe.min.js'),
  });
  const runAxe = () =>
    page.evaluate(async () => {
      const axe = Reflect.get(window, 'axe') as {
        run: (root: Document) => Promise<{
          violations: Array<{
            id: string;
            nodes: Array<{ html: string; target: string[] }>;
          }>;
        }>;
      };
      const result = await axe.run(document);
      return result.violations.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map(({ html, target }) => ({ html, target })),
      }));
    });
  await expect(runAxe()).resolves.toEqual([]);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await page.reload();
  await page.addScriptTag({
    path: path.resolve('apps/web/node_modules/axe-core/axe.min.js'),
  });
  await expect(runAxe()).resolves.toEqual([]);
});

test('[ARCH-005][CAP-001] exposes touch-sized capture and navigation targets without gesture-only actions', async ({
  page,
}) => {
  await page.goto('/');
  const targets = [
    page.getByRole('button', { name: 'Open navigation' }),
    page.getByRole('button', { name: 'Start recording' }),
    page.getByRole('button', { name: 'Enable and unlock' }),
    page.getByRole('link', { name: 'Today', exact: true }).last(),
    page.getByRole('link', { name: 'Calendar', exact: true }).last(),
  ];
  for (const target of targets) {
    const box = await target.boundingBox();
    expect(
      box,
      (await target.getAttribute('aria-label')) ?? 'touch target',
    ).not.toBeNull();
    expect(box?.width).toBeGreaterThanOrEqual(24);
    expect(box?.height).toBeGreaterThanOrEqual(24);
  }

  await page.getByRole('button', { name: 'Open navigation' }).tap();
  await page
    .getByRole('navigation', { name: 'Application sections' })
    .getByRole('link', { name: 'Calendar' })
    .tap();
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
});

test('[CAP-003][STATE-006] keeps the shell stable through repeated route, offline, and reconnect cycles', async ({
  context,
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    )
    .toBe(true);

  const manifest = await page.request.get('/manifest.webmanifest');
  await expect(manifest.json()).resolves.toMatchObject({
    display: 'standalone',
    name: 'Journal',
    start_url: '/',
  });

  await page
    .getByRole('link', { name: 'Calendar', exact: true })
    .last()
    .click();
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  await page.getByRole('link', { name: 'Search', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Search' })).toBeVisible();
  await page.getByRole('link', { name: 'Today', exact: true }).last().click();

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await context.setOffline(true);
    await page
      .getByRole('link', { name: 'Calendar', exact: true })
      .last()
      .click();
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
    await context.setOffline(false);
    await page
      .getByRole('link', { name: 'Search', exact: true })
      .last()
      .click();
    await expect(page.getByRole('heading', { name: 'Search' })).toBeVisible();
    await page.getByRole('link', { name: 'Today', exact: true }).last().click();
  }

  await expect(page.locator('#main-content')).toBeFocused();
  expect(pageErrors).toEqual([]);
});
