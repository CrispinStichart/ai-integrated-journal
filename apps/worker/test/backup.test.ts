import {
  QueueJobError,
  createQueueJobPayload,
  queueNames,
} from '@journal/database';
import { describe, expect, it, vi } from 'vitest';

import {
  BACKUP_OPERATION,
  BACKUP_SCHEDULE_KEY,
  BackupJobHandler,
} from '../src/backup.js';

function payload() {
  return createQueueJobPayload({
    identifiers: { scheduleKey: BACKUP_SCHEDULE_KEY },
    operation: BACKUP_OPERATION,
    queueName: queueNames.backup,
  });
}

describe('backup schedule worker', () => {
  it('[PORT-001][PORT-002] accepts only the content-free configured daily schedule', async () => {
    const handler = new BackupJobHandler(vi.fn(async () => undefined));
    await expect(handler.load(payload())).resolves.toEqual({
      state: 'runnable',
      input: true,
    });
    expect(() =>
      handler.load(
        createQueueJobPayload({
          identifiers: { scheduleKey: 'attacker.schedule' },
          operation: BACKUP_OPERATION,
          queueName: queueNames.backup,
        }),
      ),
    ).toThrow(QueueJobError);
  });

  it('[PORT-001][PORT-002] runs the backup once and classifies tool failure as retryable', async () => {
    const run = vi.fn(async () => undefined);
    const handler = new BackupJobHandler(run);
    const signal = new AbortController().signal;
    await handler.execute(true, signal);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(signal);

    const failed = new BackupJobHandler(async () => {
      throw new Error('synthetic tool failure');
    });
    await expect(failed.execute(true, signal)).rejects.toMatchObject({
      name: 'QueueJobError',
      disposition: 'transient',
    });
  });

  it('[PORT-002] preserves cancellation instead of retrying a stopped backup', async () => {
    const controller = new AbortController();
    controller.abort();
    const handler = new BackupJobHandler(async () => {
      throw new Error('aborted');
    });
    await expect(
      handler.execute(true, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
