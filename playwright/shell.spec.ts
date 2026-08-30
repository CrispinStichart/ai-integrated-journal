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
      if (url.includes('/api/v1/retention/tombstones')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [],
              latestGeneration: 0,
              hasMore: false,
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

test('[SEC-003–SEC-006][MODEL-001–MODEL-006][TIME-001–TIME-003] configures a disclosed provider without exposing its credential', async ({
  page,
}) => {
  await authenticateShell(page);
  const disclosureVersion = 'a'.repeat(64);
  const settings = {
    revision: 4,
    journalTimezone: 'UTC',
    retention: {
      materialGraceDays: 30,
      audioGraceDays: 30,
      rawResponseRetention: 'days_30',
      originalAudioRetention: 'indefinite',
    },
    backup: {
      configured: false,
      scheduleEnabled: false,
      schedule: '03:30 UTC daily',
      encrypted: true,
      retentionSummary: '7 daily, 5 weekly, and 12 monthly snapshots',
    },
    privacy: {
      journalPrivateByDefault: true,
      contentFreeLogs: true,
      credentialsExcludedFromExports: true,
      externalProcessingRequiresProviderEnablement: true,
      offlineCacheEncrypted: true,
    },
    providers: [
      {
        id: 'synthetic.external',
        displayName: 'Synthetic external provider',
        capabilities: ['speech_to_text'],
        disclosure: {
          contentRecipient: 'Synthetic Corp',
          external: true,
          retention: { status: 'known', value: '30 days' },
          trainingUse: { status: 'unknown' },
        },
        disclosureVersion,
        enabled: false,
        models: { speech_to_text: 'speech-v1' },
        credentialConfigured: false,
        credentialStorageAvailable: true,
        revision: 1,
      },
    ],
  };
  let providerWrite:
    | { body: Record<string, unknown>; headers: Record<string, string> }
    | undefined;
  await page.route('**/api/v1/settings', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(settings),
    }),
  );
  await page.route(
    '**/api/v1/settings/providers/synthetic.external',
    (route) => {
      providerWrite = {
        body: route.request().postDataJSON() as Record<string, unknown>,
        headers: route.request().headers(),
      };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          provider: {
            ...settings.providers[0],
            enabled: true,
            credentialConfigured: true,
            disclosureAcceptedAt: '2040-01-01T00:00:00.000Z',
            revision: 2,
          },
          idempotency: {
            key: route.request().headers()['idempotency-key'],
            replayed: false,
          },
        }),
      });
    },
  );
  await page.route('**/api/v1/auth/sessions', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions: [] }),
    }),
  );
  await page.route('**/api/v1/nudges/preferences', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        quietStartHour: 21,
        quietEndHour: 8,
        dailyLimit: 1,
        revision: 1,
        ownerTimezone: 'UTC',
        updatedAt: '2040-01-01T00:00:00.000Z',
      }),
    }),
  );

  await page.goto('/settings');
  await expect(
    page.getByRole('heading', { name: 'Synthetic external provider' }),
  ).toBeVisible();
  await expect(page.getByText('Training use is unknown.')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Provider enabled' }).check();
  await page
    .getByRole('checkbox', { name: /I understand which content/u })
    .check();
  await page.getByLabel('Replace credential').fill('browser-private-key');
  await page
    .getByRole('button', { name: 'Save Synthetic external provider' })
    .click();
  await expect.poll(() => providerWrite).toBeDefined();
  expect(providerWrite?.body).toMatchObject({
    enabled: true,
    acknowledgeDisclosureVersion: disclosureVersion,
    credential: 'browser-private-key',
    models: { speech_to_text: 'speech-v1' },
  });
  expect(providerWrite?.headers['if-match']).toBe('"settings-4"');
  expect(providerWrite?.headers['x-csrf-token']).toBe('c'.repeat(43));
  expect(providerWrite?.headers['idempotency-key']).toMatch(
    /^provider-settings-/u,
  );
  await expect(page.getByLabel('Replace credential')).toHaveValue('');
  await expect(page.getByText('browser-private-key')).toHaveCount(0);
});

test('[PORT-003–PORT-008][AC-050] creates and downloads a privacy-explicit portable export', async ({
  page,
}) => {
  await authenticateShell(page);
  const exportId = '019d2b3c-4000-7000-8000-000000000002';
  const completed = {
    id: exportId,
    status: 'completed',
    manifestSchemaVersion: 1,
    snapshotAt: '2040-01-01T00:00:00.000Z',
    createdAt: '2040-01-01T00:00:00.000Z',
    expiresAt: '2040-01-02T00:00:00.000Z',
    includeAudio: true,
    includeProviderRawResponses: false,
    entityCount: 25,
    fileCount: 8,
    archiveByteSize: '4096',
    archiveSha256: 'a'.repeat(64),
    completedAt: '2040-01-01T00:01:00.000Z',
    downloadAvailable: true,
  };
  let submitted:
    { readonly body: unknown; readonly idempotencyKey?: string } | undefined;
  await page.route('**/api/v1/exports', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [completed] }),
      });
      return;
    }
    submitted = {
      body: route.request().postDataJSON(),
      idempotencyKey: route.request().headers()['idempotency-key'],
    };
    const idempotencyKey = submitted.idempotencyKey;
    if (idempotencyKey === undefined)
      throw new Error('Export idempotency key is missing.');
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        export: {
          ...completed,
          status: 'queued',
          includeAudio: false,
          archiveByteSize: undefined,
          archiveSha256: undefined,
          completedAt: undefined,
          downloadAvailable: false,
        },
        idempotency: { key: idempotencyKey, replayed: false },
      }),
    });
  });

  await page.goto('/exports');

  await expect(page.getByRole('heading', { name: 'Exports' })).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: /provider raw responses/i }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('link', { name: 'Download ZIP' }),
  ).toHaveAttribute('href', `/api/v1/exports/${exportId}/download`);
  await page.getByRole('button', { name: 'Create export' }).click();
  await expect.poll(() => submitted).toBeDefined();
  expect(submitted?.body).toEqual({
    includeAudio: false,
    includeProviderRawResponses: false,
  });
  expect(submitted?.idempotencyKey).toMatch(/^export-/);
  await expect(page.getByText('Point-in-time export started.')).toBeVisible();
});

test('[DATA-001][DATA-002] distinguishes a missing Journal Day from a load failure', async ({
  page,
}) => {
  await authenticateShell(page);
  await page.route('**/api/v1/nudges?journalDate=*', (route) => {
    const journalDate = new URL(route.request().url()).searchParams.get(
      'journalDate',
    );
    if (journalDate === null) throw new Error('Nudge fixture date missing.');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ journalDate, evaluations: [] }),
    });
  });
  await page.route('**/api/v1/journal-days/2040-01-01**', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Journal day not found',
        status: 404,
        code: 'not_found',
      }),
    }),
  );

  await page.goto('/journal/2040-01-01');

  await expect(
    page.getByRole('heading', { name: 'Nothing recorded yet' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.route('**/api/v1/journal-days/2040-01-02**', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Journal unavailable',
        status: 500,
        code: 'internal_error',
      }),
    }),
  );
  await page.goto('/journal/2040-01-02');

  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Could not load this Journal Day.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('[SEARCH-001][SEARCH-003–SEARCH-006] searches selected layers with safe exact-revision source links', async ({
  page,
}) => {
  await authenticateShell(page);
  await page.route('**/api/v1/processors', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"items":[]}',
    }),
  );
  let requestedSearch: URL | undefined;
  await page.route('**/api/v1/search?*', (route) => {
    requestedSearch = new URL(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            fragmentId: '019c5b90-0000-7000-8000-000000000041',
            sourceKind: 'contribution_revision',
            layer: 'typed_text',
            sourceId: '019c5b90-0000-7000-8000-000000000042',
            sourceRevisionId: '019c5b90-0000-7000-8000-000000000041',
            sourceRevision: 2,
            journalDate: '2026-08-25',
            contributionId: '019c5b90-0000-7000-8000-000000000042',
            contributionType: 'typed_text',
            authority: 'manual',
            score: 0.75,
            snippet: [
              { text: 'Morning ', highlighted: false },
              {
                text: '<img src=x onerror=window.searchXss=true>',
                highlighted: true,
              },
            ],
            href: '/journal/2026-08-25?source=contribution_revision&revision=019c5b90-0000-7000-8000-000000000041',
          },
        ],
        retrieval: {
          requestedMode: 'hybrid',
          effectiveMode: 'lexical',
          fallbackReason: 'provider_unavailable',
        },
        page: { hasMore: false },
      }),
    });
  });

  await page.goto('/search');
  await page
    .getByRole('searchbox', { name: 'Words or quoted phrase' })
    .fill('morning');
  await page.getByRole('button', { name: 'Search journal' }).click();
  await expect(page.getByText('Retrieved sources and results')).toBeVisible();
  await expect(
    page.getByText('Semantic retrieval is not configured.'),
  ).toBeVisible();
  await expect(page.locator('mark')).toContainText('<img src=x onerror=');
  await expect(page.locator('blockquote img')).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, 'searchXss')),
  ).toBeUndefined();
  expect(requestedSearch?.searchParams.get('layers')).toContain('typed_text');
  expect(requestedSearch?.searchParams.get('mode')).toBe('hybrid');
  await expect(
    page.getByRole('link', { name: 'Open supporting Journal Day' }),
  ).toHaveAttribute(
    'href',
    '/journal/2026-08-25?source=contribution_revision&revision=019c5b90-0000-7000-8000-000000000041',
  );
});

test('[SEARCH-003][SEARCH-004][SEARCH-007][SEC-005] renders grounded synthesis separately from inert exact evidence', async ({
  page,
}) => {
  await authenticateShell(page);
  const answerId = '019c5b90-0000-7000-8000-000000000043';
  const revisionId = '019c5b90-0000-7000-8000-000000000041';
  await page.route('**/api/v1/processors', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"items":[]}',
    }),
  );
  await page.route('**/api/v1/search?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [],
        retrieval: { requestedMode: 'hybrid', effectiveMode: 'lexical' },
        page: { hasMore: false },
      }),
    }),
  );
  const answer = {
    id: answerId,
    question: 'What did I do this morning?',
    status: 'succeeded',
    retrieval: { requestedMode: 'hybrid', effectiveMode: 'lexical' },
    synthesis: 'You took a morning walk.',
    citations: [
      {
        citationId: `cite_${'a'.repeat(32)}`,
        sourceKind: 'contribution_revision',
        layer: 'typed_text',
        sourceId: '019c5b90-0000-7000-8000-000000000042',
        sourceRevisionId: revisionId,
        sourceRevision: 2,
        journalDate: '2026-08-25',
        authority: 'manual',
        retrievedQuote:
          '<img src=x onerror=window.answerXss=true> Morning walk',
        evidence: {
          normalization: 'NFC_LF_V1',
          offsetUnit: 'utf16_code_unit',
          startUtf16: 0,
          endUtf16: 57,
          quoteSha256: 'b'.repeat(64),
        },
        href: `/journal/2026-08-25?source=contribution_revision&revision=${revisionId}&startUtf16=0&endUtf16=57`,
      },
    ],
    requestedAt: '2026-08-25T04:00:00.000Z',
    completedAt: '2026-08-25T04:00:01.000Z',
  };
  await page.route('**/api/v1/search/answers', (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify(answer),
    }),
  );
  await page.route(`**/api/v1/search/answers/${answerId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(answer),
    }),
  );

  await page.goto('/search');
  await page
    .getByRole('searchbox', { name: 'Words or quoted phrase' })
    .fill('What did I do this morning?');
  await page.getByRole('button', { name: 'Answer from evidence' }).click();
  await expect(page.getByText('AI-generated synthesis')).toBeVisible();
  await expect(page.getByText('You took a morning walk.')).toBeVisible();
  await expect(page.getByText('Retrieved quote')).toBeVisible();
  await expect(page.locator('blockquote img')).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, 'answerXss')),
  ).toBeUndefined();
  await expect(
    page.getByRole('link', { name: 'Open precise supporting evidence' }),
  ).toHaveAttribute('href', expect.stringContaining(`revision=${revisionId}`));
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
  await page.clock.setFixedTime(new Date(`${date}T12:00:00.000Z`));
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
    if (url.pathname === '/api/v1/retention/tombstones') {
      await respond({ items: [], latestGeneration: 0, hasMore: false });
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
