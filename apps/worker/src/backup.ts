import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  QueueJobError,
  queueNames,
  registerQueueWorker,
  type CanonicalJobHandler,
  type CanonicalJobInput,
  type QueueJobPayload,
} from '@journal/database';
import type { PgBoss } from 'pg-boss';

export const BACKUP_OPERATION = 'backup';
export const BACKUP_SCHEDULE_KEY = 'backup.daily';

export type BackupCommand = (signal: AbortSignal) => Promise<void>;

const backupScript = fileURLToPath(
  new URL('../../../packages/database/scripts/backup.mjs', import.meta.url),
);

export function runLocalBackupCommand(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [backupScript, 'create'], {
      env: process.env,
      stdio: 'ignore',
      signal,
    });
    child.once('error', reject);
    child.once('close', (code, terminationSignal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Backup command failed (${terminationSignal ?? `exit ${String(code)}`}).`,
          ),
        );
    });
  });
}

export class BackupJobHandler implements CanonicalJobHandler<true> {
  public constructor(private readonly runBackup: BackupCommand) {}

  public load(payload: QueueJobPayload): Promise<CanonicalJobInput<true>> {
    if (
      payload.operation !== BACKUP_OPERATION ||
      payload.identifiers.scheduleKey !== BACKUP_SCHEDULE_KEY ||
      Object.keys(payload.identifiers).join(',') !== 'scheduleKey'
    ) {
      throw new QueueJobError('permanent', 'Unsupported backup payload.');
    }
    return Promise.resolve({ state: 'runnable', input: true });
  }

  public async execute(_input: true, signal: AbortSignal): Promise<void> {
    try {
      await this.runBackup(signal);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      throw new QueueJobError(
        'transient',
        `Backup failed: ${error instanceof Error ? error.name : 'unknown_error'}`,
      );
    }
  }
}

export function registerBackupConsumer(input: {
  readonly boss: PgBoss;
  readonly runBackup?: BackupCommand;
}): Promise<string> {
  return registerQueueWorker({
    boss: input.boss,
    queueName: queueNames.backup,
    handler: new BackupJobHandler(input.runBackup ?? runLocalBackupCommand),
  });
}
