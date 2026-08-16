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
              ownerId: '018f0000-0000-7000-8000-000000000001',
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

test('[DATA-001–DATA-004][DATA-010–DATA-012][DATA-026][TIME-001–TIME-003][STATE-006–STATE-007][SEC-001–SEC-003][AC-001][AC-003] manages a source-preserving Journal Day with an encrypted offline outbox and cache', async ({
  context,
  page,
}) => {
  const date = '2026-08-16';
  const ids = {
    author: '018f0000-0000-7000-8000-000000000001',
    day: '018f0000-0000-7000-8000-000000000002',
    first: '018f0000-0000-7000-8000-000000000003',
    firstRevision: '018f0000-0000-7000-8000-000000000004',
    second: '018f0000-0000-7000-8000-000000000005',
    secondRevision: '018f0000-0000-7000-8000-000000000006',
  };
  type BrowserContribution = {
    id: string;
    journalDayId: string;
    journalDate: string;
    authorId: string;
    sourceType: 'typed_text';
    capturedAt: string;
    capturedTimezone: string;
    journalTimezone: string;
    journalDateAssignment: 'default' | 'user_override';
    currentRevision: {
      id: string;
      contributionId: string;
      revision: number;
      text: string;
      authority: 'manual';
      authorId: string;
      createdAt: string;
      editReason?: string;
    };
    deletedAt?: string;
    restoredAt?: string;
  };
  const makeContribution = (
    id: string,
    revisionId: string,
    text: string,
  ): BrowserContribution => ({
    id,
    journalDayId: ids.day,
    journalDate: date,
    authorId: ids.author,
    sourceType: 'typed_text',
    capturedAt: `${date}T12:00:00.000Z`,
    capturedTimezone: 'UTC',
    journalTimezone: 'UTC',
    journalDateAssignment: 'default',
    currentRevision: {
      id: revisionId,
      contributionId: id,
      revision: 1,
      text,
      authority: 'manual',
      authorId: ids.author,
      createdAt: `${date}T12:00:00.000Z`,
    },
  });
  const contributions: BrowserContribution[] = [
    makeContribution(ids.first, ids.firstRevision, 'Morning reflection'),
    makeContribution(ids.second, ids.secondRevision, 'Evening reflection'),
  ];
  const revisionHistory = new Map(
    contributions.map((contribution) => [
      contribution.id,
      [contribution.currentRevision],
    ]),
  );

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const respond = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    if (url.pathname === '/api/v1/auth/status') {
      await respond({
        bootstrapRequired: false,
        authenticated: true,
        ownerId: ids.author,
        displayName: 'Test owner',
        csrfToken: 'c'.repeat(43),
        sessionExpiresAt: '2026-08-17T12:00:00.000Z',
        passkeyCount: 1,
      });
      return;
    }
    if (url.pathname === '/api/v1/journal-days') {
      await respond({
        items: [
          {
            id: ids.day,
            journalDate: date,
            contributionCount: contributions.filter(
              (item) => item.deletedAt === undefined,
            ).length,
            latestContributionAt: `${date}T12:00:00.000Z`,
          },
        ],
        page: { hasMore: false },
      });
      return;
    }
    if (url.pathname === `/api/v1/journal-days/${date}`) {
      await respond({
        id: ids.day,
        journalDate: date,
        createdAt: `${date}T10:00:00.000Z`,
        contributions,
      });
      return;
    }
    if (
      url.pathname === '/api/v1/contributions' &&
      request.method() === 'POST'
    ) {
      const input = request.postDataJSON() as {
        contributionId: string;
        revisionId: string;
        text: string;
        capturedAt: string;
        capturedTimezone: string;
        journalTimezone: string;
        journalDateAssignment: 'default' | 'user_override';
      };
      const created: BrowserContribution = {
        ...makeContribution(input.contributionId, input.revisionId, input.text),
        capturedAt: input.capturedAt,
        capturedTimezone: input.capturedTimezone,
        journalTimezone: input.journalTimezone,
        journalDateAssignment: input.journalDateAssignment,
      };
      contributions.push(created);
      await respond(
        {
          contribution: created,
          idempotency: {
            key: request.headers()['idempotency-key'],
            replayed: false,
          },
        },
        201,
      );
      return;
    }
    const contributionMatch = /^\/api\/v1\/contributions\/([^/]+)$/.exec(
      url.pathname,
    );
    if (contributionMatch?.[1] && request.method() === 'PATCH') {
      const contribution = contributions.find(
        (item) => item.id === contributionMatch[1],
      );
      const input = request.postDataJSON() as {
        revisionId: string;
        text: string;
        editReason?: string;
      };
      if (contribution) {
        contribution.currentRevision = {
          id: input.revisionId,
          contributionId: contribution.id,
          revision: contribution.currentRevision.revision + 1,
          text: input.text,
          authority: 'manual',
          authorId: ids.author,
          createdAt: `${date}T12:30:00.000Z`,
          ...(input.editReason === undefined
            ? {}
            : { editReason: input.editReason }),
        };
        revisionHistory
          .get(contribution.id)
          ?.push(contribution.currentRevision);
      }
      await respond({
        contribution,
        idempotency: {
          key: request.headers()['idempotency-key'],
          replayed: false,
        },
      });
      return;
    }
    if (contributionMatch?.[1] && request.method() === 'DELETE') {
      const contribution = contributions.find(
        (item) => item.id === contributionMatch[1],
      );
      if (contribution) contribution.deletedAt = `${date}T13:00:00.000Z`;
      await respond({
        contribution,
        idempotency: {
          key: request.headers()['idempotency-key'],
          replayed: false,
        },
      });
      return;
    }
    const restoreMatch = /^\/api\/v1\/contributions\/([^/]+)\/restore$/.exec(
      url.pathname,
    );
    if (restoreMatch?.[1]) {
      const contribution = contributions.find(
        (item) => item.id === restoreMatch[1],
      );
      if (contribution) {
        delete contribution.deletedAt;
        contribution.restoredAt = `${date}T14:00:00.000Z`;
      }
      await respond({
        contribution,
        idempotency: {
          key: request.headers()['idempotency-key'],
          replayed: false,
        },
      });
      return;
    }
    const historyMatch = /^\/api\/v1\/contributions\/([^/]+)\/revisions$/.exec(
      url.pathname,
    );
    if (historyMatch?.[1]) {
      await respond({
        items: revisionHistory.get(historyMatch[1]) ?? [],
        page: { hasMore: false },
      });
      return;
    }
    await respond({ title: 'Not found' }, 404);
  });

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Today', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.getByRole('article').first()).toContainText(
    'Manual source',
  );
  await expect(page.getByRole('article').first()).toContainText('UTC');

  await page.getByLabel('Local unlock secret').fill('test local secret');
  await page.getByRole('button', { name: 'Enable and unlock' }).click();
  await expect(page.getByText(/Offline journal unlocked/)).toBeVisible();

  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await page.getByLabel('Local unlock secret').fill('test local secret');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await context.setOffline(true);
  await page
    .getByPlaceholder('What would you like to remember?')
    .fill('Midday reflection');
  await page.getByRole('button', { name: 'Add contribution' }).click();
  await expect(page.getByRole('article')).toHaveCount(3);
  await expect(page.getByRole('article').last()).toContainText('Saved locally');

  await context.setOffline(false);
  await expect(page.getByRole('article').last()).not.toContainText(
    'Saved locally',
  );

  await page
    .getByRole('article')
    .first()
    .getByRole('button', { name: 'History' })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Revision history' }),
  ).toContainText('Morning reflection');
  await page
    .getByRole('dialog', { name: 'Revision history' })
    .getByRole('button', { name: 'Close', exact: true })
    .click();

  const firstContribution = page.getByRole('article').first();
  await firstContribution.getByRole('button', { name: 'Edit' }).click();
  await firstContribution
    .getByLabel('Contribution text')
    .fill('Updated morning reflection');
  await firstContribution
    .getByRole('button', { name: 'Save revision' })
    .click();
  await expect(firstContribution).toContainText('Updated morning reflection');
  await firstContribution.getByRole('button', { name: 'History' }).click();
  const updatedHistory = page.getByRole('dialog', {
    name: 'Revision history',
  });
  await expect(updatedHistory).toContainText('Revision 1');
  await expect(updatedHistory).toContainText('Morning reflection');
  await expect(updatedHistory).toContainText('Revision 2');
  await expect(updatedHistory).toContainText('Updated morning reflection');
  await updatedHistory
    .getByRole('button', { name: 'Close', exact: true })
    .click();

  await page
    .getByRole('article')
    .first()
    .getByRole('button', { name: 'Delete' })
    .click();
  const deletion = page.getByRole('dialog', {
    name: 'Delete this contribution?',
  });
  await expect(deletion).toContainText(
    'recoverable during the deletion grace period',
  );
  await deletion.getByRole('button', { name: 'Delete contribution' }).click();
  await expect(page.getByRole('article').first()).toContainText('Deleted');
  await page
    .getByRole('article')
    .first()
    .getByRole('button', { name: 'Restore' })
    .click();
  await expect(page.getByRole('article').first()).toContainText(
    'Manual source',
  );

  await page
    .getByRole('link', { name: 'Calendar', exact: true })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: /August 16, 2026, 3 contributions/ }),
  ).toBeVisible();
});
