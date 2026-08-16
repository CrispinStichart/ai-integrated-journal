// @vitest-environment jsdom

import 'fake-indexeddb/auto';

import type { CreateContributionRequest } from '@journal/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OfflineJournal } from '../src/journal/offline';
import { JournalIndexedDb } from '../src/storage/indexed-db';

const OWNER_ID = '018f0000-0000-7000-8000-000000000001';
const DAY_ID = '018f0000-0000-7000-8000-000000000002';
const CONTRIBUTION_ID = '018f0000-0000-7000-8000-000000000003';
const REVISION_ID = '018f0000-0000-7000-8000-000000000004';
const capturedAt = '2026-08-16T12:00:00.000Z';
const stores: JournalIndexedDb[] = [];

function createStore(): JournalIndexedDb {
  const storage = new JournalIndexedDb(`offline-${crypto.randomUUID()}`);
  stores.push(storage);
  return storage;
}

function createInput(
  contributionId = CONTRIBUTION_ID,
  revisionId = REVISION_ID,
): CreateContributionRequest {
  return {
    contributionId,
    revisionId,
    proposedJournalDayId: DAY_ID,
    sourceType: 'typed_text',
    text: `private text ${contributionId}`,
    capturedAt,
    capturedTimezone: 'UTC',
    journalTimezone: 'UTC',
    journalDate: '2026-08-16',
    journalDateAssignment: 'default',
  };
}

function contribution(input = createInput(), revision = 1) {
  return {
    id: input.contributionId,
    journalDayId: DAY_ID,
    journalDate: input.journalDate,
    authorId: OWNER_ID,
    sourceType: input.sourceType,
    capturedAt: input.capturedAt,
    capturedTimezone: input.capturedTimezone,
    journalTimezone: input.journalTimezone,
    journalDateAssignment: input.journalDateAssignment,
    currentRevision: {
      id: input.revisionId,
      contributionId: input.contributionId,
      revision,
      text: input.text,
      authority: 'manual',
      authorId: OWNER_ID,
      createdAt: capturedAt,
    },
  };
}

function day(input = createInput()) {
  return {
    id: DAY_ID,
    journalDate: input.journalDate,
    createdAt: capturedAt,
    contributions: [contribution(input)],
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value,
  });
}

describe('offline text outbox and cached reads (SEC-001–SEC-003, AC-003)', () => {
  beforeEach(() => setOnline(true));

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await Promise.all(stores.map((storage) => storage.destroy()));
    stores.length = 0;
  });

  it('encrypts private records and requires the separate local unlock after restart', async () => {
    const storage = createStore();
    const first = new OfflineJournal(storage, 1);
    await first.initialize(OWNER_ID);
    await first.setup('local-only secret');
    await first.enqueueCreate(createInput(), 'create-offline-1');
    await first.enqueueCreate(createInput(), 'create-offline-1');

    const stored = await storage.listOutbox(OWNER_ID);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('private text');

    first.lock();
    await expect(first.pendingForDay('2026-08-16')).resolves.toEqual([]);
    await expect(first.unlock('wrong secret')).rejects.toThrow('incorrect');
    await first.unlock('local-only secret');
    await expect(first.pendingForDay('2026-08-16')).resolves.toMatchObject([
      { kind: 'create', idempotencyKey: 'create-offline-1' },
    ]);
  });

  it('preserves strict enqueue order across a browser-process restart', async () => {
    const storage = createStore();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const first = new OfflineJournal(storage, 1);
    await first.initialize(OWNER_ID);
    await first.setup('local-only secret');
    await first.enqueueCreate(createInput(), 'create-before-restart');

    const restarted = new OfflineJournal(storage, 1);
    await restarted.initialize(OWNER_ID);
    await restarted.unlock('local-only secret');
    await restarted.enqueueCreate(
      createInput(
        '018f0000-0000-7000-8000-000000000005',
        '018f0000-0000-7000-8000-000000000006',
      ),
      'create-after-restart',
    );

    expect(
      (await storage.listOutbox(OWNER_ID)).map((record) => record.id),
    ).toEqual(['create-before-restart', 'create-after-restart']);
  });

  it('replays mutations in durable order with original UUIDs and idempotency keys', async () => {
    const storage = createStore();
    const journal = new OfflineJournal(storage, 1);
    await journal.initialize(OWNER_ID);
    await journal.setup('local-only secret');
    const secondId = '018f0000-0000-7000-8000-000000000005';
    const secondRevision = '018f0000-0000-7000-8000-000000000006';
    const inputs = [
      createInput(),
      createInput(secondId, secondRevision),
    ] as const;
    await journal.enqueueCreate(inputs[0], 'create-offline-1');
    await journal.enqueueCreate(inputs[1], 'create-offline-2');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          contribution: contribution(inputs[0]),
          idempotency: { key: 'create-offline-1', replayed: false },
        }),
      )
      .mockResolvedValueOnce(
        json({
          contribution: contribution(inputs[1]),
          idempotency: { key: 'create-offline-2', replayed: false },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await journal.replay('csrf-token');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[1]?.headers)).toEqual([
      expect.objectContaining({ 'idempotency-key': 'create-offline-1' }),
      expect.objectContaining({ 'idempotency-key': 'create-offline-2' }),
    ]);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      contributionId: CONTRIBUTION_ID,
      revisionId: REVISION_ID,
    });
    expect(journal.pendingCount.value).toBe(0);
  });

  it('stops ordered replay and exposes an edit conflict without overwriting either version', async () => {
    const storage = createStore();
    const journal = new OfflineJournal(storage, 1);
    await journal.initialize(OWNER_ID);
    await journal.setup('local-only secret');
    await journal.enqueueEdit({
      contributionId: CONTRIBUTION_ID,
      journalDate: '2026-08-16',
      baseRevision: 1,
      revisionId: '018f0000-0000-7000-8000-000000000007',
      text: 'my offline draft',
      editReason: 'offline correction',
      idempotencyKey: 'edit-offline-1',
    });
    const latest = {
      ...contribution(),
      currentRevision: {
        ...contribution().currentRevision,
        id: '018f0000-0000-7000-8000-000000000008',
        revision: 2,
        text: 'newer server text',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          json(
            {
              type: 'about:blank',
              title: 'Contribution changed',
              status: 412,
              code: 'etag_mismatch',
              correlationId: '018f0000-0000-7000-8000-000000000099',
            },
            412,
          ),
        )
        .mockResolvedValueOnce(json(latest)),
    );

    await journal.replay('csrf-token');

    expect(journal.conflict.value).toMatchObject({
      current: { currentRevision: { text: 'newer server text' } },
      draft: 'my offline draft',
    });
    expect(journal.pendingCount.value).toBe(1);
    await journal.resolveConflict('csrf-token', false);
    expect(journal.pendingCount.value).toBe(0);
  });

  it('falls back to an encrypted cached day, expires it, and clears only reads on logout', async () => {
    const storage = createStore();
    const journal = new OfflineJournal(storage, 1);
    await journal.initialize(OWNER_ID);
    await journal.setup('local-only secret');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(day())),
    );

    await expect(journal.readDay('2026-08-16')).resolves.toMatchObject({
      contributions: [{ id: CONTRIBUTION_ID }],
    });
    await journal.enqueueCreate(createInput(), 'create-still-pending');
    expect(journal.cacheDays.value).toBe(1);

    setOnline(false);
    await expect(journal.readDay('2026-08-16')).resolves.toMatchObject({
      journalDate: '2026-08-16',
    });
    expect(journal.lastReadFromCache.value).toBe(true);

    await journal.logout();
    expect(await storage.listJournalCache(OWNER_ID)).toEqual([]);
    expect(await storage.listOutbox(OWNER_ID)).toHaveLength(1);
    expect(journal.unlocked.value).toBe(false);

    await journal.unlock('local-only secret');
    setOnline(true);
    await journal.readDay('2026-08-16');
    const cached = await storage.getJournalCache(OWNER_ID, '2026-08-16');
    if (cached === undefined) throw new Error('Expected a cached Journal Day');
    await storage.putJournalCache({
      ...cached,
      refreshedAt: '2020-01-01T00:00:00.000Z',
    });
    setOnline(false);
    await expect(journal.readDay('2026-08-16')).rejects.toThrow('expired');
  });

  it('bounds the read cache to the 200 most recently accessed Journal Days', async () => {
    const storage = createStore();
    const journal = new OfflineJournal(storage, 1);
    await journal.initialize(OWNER_ID);
    await journal.setup('local-only secret');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        const journalDate = path.split('/').at(-1)?.split('?')[0];
        return json({
          id: DAY_ID,
          journalDate,
          createdAt: capturedAt,
          contributions: [],
        });
      }),
    );

    const dates: string[] = [];
    for (let offset = 0; offset < 201; offset += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + offset))
        .toISOString()
        .slice(0, 10);
      dates.push(date);
      await journal.readDay(date);
    }

    expect(await storage.listJournalCache(OWNER_ID)).toHaveLength(200);
    expect(
      await storage.getJournalCache(OWNER_ID, dates[0] ?? ''),
    ).toBeUndefined();
    expect(journal.cacheDays.value).toBe(200);
  });

  it('fails closed before setup and evicts read cache first under quota pressure', async () => {
    const storage = createStore();
    const journal = new OfflineJournal(storage, 1);

    await expect(journal.setup('local-only secret')).rejects.toThrow(
      'authenticated owner',
    );
    await journal.logout();
    await journal.initialize(OWNER_ID);
    await expect(journal.setup('short')).rejects.toThrow('at least 8');
    await expect(journal.unlock('local-only secret')).rejects.toThrow(
      'has not been enabled',
    );
    await journal.replay('csrf-token');
    await journal.resolveConflict('csrf-token', false);

    await journal.setup('local-only secret');
    const clearCache = vi.spyOn(storage, 'clearJournalCache');
    vi.spyOn(storage, 'putOutbox').mockRejectedValueOnce(
      new DOMException('Storage full', 'QuotaExceededError'),
    );
    await expect(
      journal.enqueueCreate(createInput(), 'create-over-quota'),
    ).rejects.toThrow('Local storage is full');
    expect(clearCache).toHaveBeenCalledWith(OWNER_ID);

    setOnline(false);
    await journal.replay('csrf-token');
  });
});
