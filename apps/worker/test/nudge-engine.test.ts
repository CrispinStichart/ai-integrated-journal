import type { DatabaseClient, QueueJobPayload } from '@journal/database';
import { createJobFingerprint } from '@journal/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
  runSchedule: vi.fn(),
}));

const registerQueueWorker = vi.hoisted(() => vi.fn());

vi.mock('@journal/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@journal/database')>()),
  NudgeRepository: class {
    public readonly runSchedule = repository.runSchedule;
  },
  registerQueueWorker,
}));

import {
  NUDGE_DIGEST_OPERATION,
  NudgeDigestJobHandler,
  registerNudgeDigestConsumer,
} from '../src/nudge-engine.js';

const payload: QueueJobPayload = {
  schemaVersion: 1,
  operation: NUDGE_DIGEST_OPERATION,
  identifiers: { scheduleKey: 'nudges.digest' },
  fingerprint: createJobFingerprint({
    queueName: 'journal.notifications',
    operation: NUDGE_DIGEST_OPERATION,
    identifiers: { scheduleKey: 'nudges.digest' },
  }),
};

describe('scheduled nudge digest worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[NUDGE-005][STATE-003] accepts only the content-free scheduled identifier contract', async () => {
    const handler = new NudgeDigestJobHandler({} as DatabaseClient);
    await expect(handler.load(payload)).resolves.toEqual({
      input: true,
      state: 'runnable',
    });
    expect(() => handler.load({ ...payload, operation: 'unexpected' })).toThrow(
      expect.objectContaining({ disposition: 'permanent' }),
    );
    expect(JSON.stringify(payload)).not.toMatch(/journalText|prompt|response/u);
  });

  it('[NUDGE-005][STATE-003] refuses aborted jobs and evaluates the schedule using execution time', async () => {
    const database = {} as DatabaseClient;
    const now = new Date('2026-08-24T16:00:00.000Z');
    const handler = new NudgeDigestJobHandler(database, () => now);
    const aborted = AbortSignal.abort(new Error('worker shutting down'));

    await expect(handler.execute(true, aborted)).rejects.toThrow(
      'worker shutting down',
    );
    expect(repository.runSchedule).not.toHaveBeenCalled();

    await handler.execute(true, new AbortController().signal);
    expect(repository.runSchedule).toHaveBeenCalledOnce();
    expect(repository.runSchedule).toHaveBeenCalledWith(now);
  });

  it('[NUDGE-005][STATE-003] registers the digest handler on the notifications queue', async () => {
    const boss = {};
    const database = {} as DatabaseClient;
    registerQueueWorker.mockResolvedValue('worker-id');

    await expect(
      registerNudgeDigestConsumer({ boss: boss as never, database }),
    ).resolves.toBe('worker-id');
    expect(registerQueueWorker).toHaveBeenCalledOnce();
    expect(registerQueueWorker).toHaveBeenCalledWith({
      boss,
      queueName: 'journal.notifications',
      handler: expect.any(NudgeDigestJobHandler),
    });
  });
});
