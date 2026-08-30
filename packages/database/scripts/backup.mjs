#!/usr/bin/env node
import {
  BackupError,
  configurationFromEnvironment,
  createBackup,
  initializeRepository,
  restoreBackup,
} from './backup-core.mjs';

async function main() {
  const command = process.argv[2];
  if (command === 'init') {
    const configuration = configurationFromEnvironment(process.env, 'backup');
    await initializeRepository(configuration);
    process.stdout.write('Encrypted backup repository is ready.\n');
    return;
  }
  if (command === 'create') {
    const result = await createBackup(
      configurationFromEnvironment(process.env, 'backup'),
    );
    process.stdout.write(
      `Backup ${result.repositorySnapshotId} validated (${String(result.blobCount)} blobs; tombstone generation ${String(result.maxTombstoneGeneration)}).\n`,
    );
    return;
  }
  if (command === 'restore') {
    const result = await restoreBackup(
      configurationFromEnvironment(process.env, 'restore'),
    );
    process.stdout.write(
      `Restore validated (${String(result.restoredBlobCount)} blobs, ${String(result.tombstoneCount)} tombstones, ${String(result.resumedJobCount)} jobs resumed, ${String(result.canceledJobCount)} jobs canceled).\n`,
    );
    return;
  }
  throw new BackupError('Usage: backup.mjs init|create|restore');
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.name : 'BackupError'}: ${error instanceof Error ? error.message : 'Unknown backup failure'}\n`,
  );
  process.exitCode = 1;
});
