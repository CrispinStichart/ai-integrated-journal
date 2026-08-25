import type {
  NudgeActionRequest,
  NudgeDayResource,
  NudgePreference,
} from '@journal/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
  act: vi.fn(),
  getDay: vi.fn(),
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));

const repositoryConstructor = vi.hoisted(() => vi.fn());

vi.mock('@journal/database', () => ({
  NudgeRepository: class {
    public readonly act = repository.act;
    public readonly getDay = repository.getDay;
    public readonly getPreferences = repository.getPreferences;
    public readonly updatePreferences = repository.updatePreferences;

    public constructor(database: unknown) {
      repositoryConstructor(database);
    }
  },
}));

import { PostgresNudgeService } from '../src/nudge-service.js';

const OWNER_ID = '019c5b90-0000-7000-8000-000000000050';
const DIGEST_ID = '019c5b90-0000-7000-8000-000000000051';
const ITEM_ID = '019c5b90-0000-7000-8000-000000000052';
const CONTRIBUTION_ID = '019c5b90-0000-7000-8000-000000000053';
const REVISION_ID = '019c5b90-0000-7000-8000-000000000054';
const NOW = new Date('2026-08-24T15:30:00.000Z');

const day: NudgeDayResource = {
  journalDate: '2026-08-24',
  evaluations: [],
};

const preference: NudgePreference = {
  quietStartHour: 21,
  quietEndHour: 8,
  dailyLimit: 2,
  revision: 4,
  ownerTimezone: 'America/Chicago',
  updatedAt: NOW.toISOString(),
};

describe('PostgresNudgeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[NUDGE-005][SEC-001] delegates owner-scoped reads and preference writes with concurrency and idempotency data', async () => {
    const database = { marker: 'database' };
    repository.getDay.mockResolvedValue(day);
    repository.getPreferences.mockResolvedValue(preference);
    repository.updatePreferences.mockResolvedValue({
      preference: { ...preference, revision: 5 },
      replayed: false,
    });
    const service = new PostgresNudgeService(
      database as never,
      undefined,
      () => NOW,
    );

    await expect(service.getDay(OWNER_ID, day.journalDate)).resolves.toBe(day);
    await expect(service.getPreferences(OWNER_ID)).resolves.toBe(preference);
    await expect(
      service.updatePreferences(
        OWNER_ID,
        4,
        { quietStartHour: 22, quietEndHour: 7, dailyLimit: 1 },
        'preferences-request-1',
      ),
    ).resolves.toEqual({
      preference: { ...preference, revision: 5 },
      replayed: false,
    });

    expect(repositoryConstructor).toHaveBeenCalledWith(database);
    expect(repository.getDay).toHaveBeenCalledWith(OWNER_ID, '2026-08-24');
    expect(repository.getPreferences).toHaveBeenCalledWith(OWNER_ID);
    expect(repository.updatePreferences).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      expectedRevision: 4,
      request: { quietStartHour: 22, quietEndHour: 7, dailyLimit: 1 },
      idempotencyKey: 'preferences-request-1',
      now: NOW,
    });
  });

  it('[NUDGE-006][STATE-004] reloads committed digest state before returning and publishing an update', async () => {
    const action: NudgeActionRequest = {
      action: 'answer',
      itemId: ITEM_ID,
      text: 'I slept well.',
      contributionId: CONTRIBUTION_ID,
      revisionId: REVISION_ID,
      capturedAt: NOW.toISOString(),
      capturedTimezone: 'Etc/UTC',
    };
    repository.act.mockResolvedValue({
      journalDate: day.journalDate,
      responseContributionId: CONTRIBUTION_ID,
      replayed: true,
    });
    repository.getDay.mockResolvedValue(day);
    const publish = vi.fn();
    const service = new PostgresNudgeService({} as never, publish, () => NOW);

    await expect(
      service.act(
        OWNER_ID,
        DIGEST_ID,
        3,
        action,
        'answer-request-1',
        'correlation-1',
      ),
    ).resolves.toEqual({
      day,
      responseContributionId: CONTRIBUTION_ID,
      replayed: true,
    });

    expect(repository.act).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      digestId: DIGEST_ID,
      expectedRevision: 3,
      request: action,
      idempotencyKey: 'answer-request-1',
      correlationId: 'correlation-1',
      now: NOW,
    });
    expect(repository.getDay).toHaveBeenCalledWith(OWNER_ID, '2026-08-24');
    const [actCallOrder] = repository.act.mock.invocationCallOrder;
    const [reloadCallOrder] = repository.getDay.mock.invocationCallOrder;
    if (actCallOrder === undefined || reloadCallOrder === undefined)
      throw new Error('Expected both repository calls to be observed.');
    expect(actCallOrder).toBeLessThan(reloadCallOrder);
    expect(publish).toHaveBeenCalledWith(OWNER_ID, {
      eventId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      eventType: 'nudge.updated',
      schemaVersion: 1,
      occurredAt: NOW.toISOString(),
      payload: { digestId: DIGEST_ID, journalDate: '2026-08-24' },
    });
  });

  it('[NUDGE-005] uses the wall clock when no clock is injected', async () => {
    repository.updatePreferences.mockResolvedValue({
      preference,
      replayed: false,
    });
    const before = Date.now();
    const service = new PostgresNudgeService({} as never);

    await service.updatePreferences(
      OWNER_ID,
      4,
      { quietStartHour: 21, quietEndHour: 8, dailyLimit: 2 },
      'preferences-request-2',
    );
    const after = Date.now();

    const [{ now }] = repository.updatePreferences.mock.calls[0] as [
      { now: Date },
    ];
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
  });
});
