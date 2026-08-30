import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BACKUP_FORMAT_VERSION,
  EXPECTED_PG_BOSS_SCHEMA_VERSION,
  BackupError,
  configurationFromEnvironment,
  createBackup,
  initializeRepository,
  parseChecksumFile,
  publicConfiguration,
  restoreBackup,
  sha256File,
  validateBackupPaths,
} from '../scripts/backup-core.mjs';

const temporaryDirectories = [];

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function privatePaths(root) {
  return {
    blobDirectory: path.join(root, 'live', 'blobs'),
    repositoryDirectory: path.join(root, 'repository'),
    stagingDirectory: path.join(root, 'staging'),
    passwordFile: path.join(root, 'secrets', 'restic.password'),
  };
}

describe('local encrypted backup tooling', () => {
  it('[PORT-001][SEC-005][SEC-007] rejects overlapping storage and emits only allowlisted non-secret configuration', async () => {
    const root = await temporaryDirectory('journal-backup-paths-');
    expect(() =>
      validateBackupPaths({
        ...privatePaths(root),
        repositoryDirectory: path.join(root, 'live', 'blobs', 'backup'),
      }),
    ).toThrow(BackupError);

    const metadata = publicConfiguration({
      APP_ENV: 'production',
      AUTH_ORIGIN: 'https://journal.example',
      DATABASE_URL:
        'postgresql://journal:secret-password@database.internal:5433/journal?sslmode=require',
      WEBAUTHN_RP_ID: 'journal.example',
      PROVIDER_API_KEY: 'secret-provider-key',
    });
    expect(metadata).toMatchObject({
      appEnvironment: 'production',
      database: {
        database: 'journal',
        host: 'database.internal',
        port: '5433',
      },
    });
    expect(JSON.stringify(metadata)).not.toContain('secret-password');
    expect(JSON.stringify(metadata)).not.toContain('secret-provider-key');
    expect(JSON.stringify(metadata)).not.toContain('journal:');
  });

  it('[PORT-001][SEC-005] initializes owner-only restic state with a generated 256-bit password', async () => {
    const root = await temporaryDirectory('journal-backup-init-');
    const configuration = validateBackupPaths(privatePaths(root));
    const commands = [];
    await initializeRepository(configuration, {
      runCommand: async (command, arguments_) => {
        commands.push([command, arguments_]);
        return { stdout: '', stderr: '' };
      },
    });
    expect(commands).toEqual([['restic', ['init']]]);
    expect(await readFile(configuration.passwordFile, 'utf8')).toMatch(
      /^[0-9a-f]{64}\n$/u,
    );
    expect((await stat(configuration.passwordFile)).mode & 0o777).toBe(0o600);
  });

  it('[PORT-001][PORT-002][RET-006] creates a coordinated dump/blob/tombstone snapshot and commits its deletion checkpoint only after restic check', async () => {
    const root = await temporaryDirectory('journal-backup-create-');
    const paths = privatePaths(root);
    const blobKey = 'audio/owner/recording.webm';
    const blobBytes = Buffer.from('bounded immutable audio fixture');
    const blobPath = path.join(paths.blobDirectory, 'final', blobKey);
    await mkdir(path.dirname(blobPath), { recursive: true });
    await writeFile(blobPath, blobBytes);
    const blobDigest = await sha256File(blobPath);
    const queries = [];
    const client = {
      query: vi.fn(async (text) => {
        queries.push(String(text));
        if (String(text).includes('pg_export_snapshot')) {
          return {
            rows: [
              {
                snapshot_id: '00000003-0000002B-1',
                snapshot_at: new Date('2026-08-30T00:00:00.000Z'),
              },
            ],
          };
        }
        if (String(text).includes('select storage_area')) {
          return {
            rows: [
              {
                storage_area: 'final',
                blob_key: blobKey,
                byte_size: String(blobDigest.byteSize),
                sha256: blobDigest.sha256,
              },
            ],
          };
        }
        if (String(text).includes('from journal.deletion_tombstone')) {
          return {
            rows: [
              {
                id: '019c5b90-0000-7000-8000-000000000801',
                owner_id: '019c5b90-0000-7000-8000-000000000802',
                entity_kind: 'contribution',
                entity_id: '019c5b90-0000-7000-8000-000000000803',
                deleted_at: '2026-08-29T00:00:00.000Z',
                generation: 7,
                correlation_id: '019c5b90-0000-7000-8000-000000000804',
                created_at: '2026-08-29T00:00:00.000Z',
              },
            ],
          };
        }
        if (String(text).includes('from pgboss.version')) {
          return { rows: [{ version: 37 }] };
        }
        if (String(text).includes('journal_migrations')) {
          return { rows: [{ migration_id: '42' }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (text) => {
        queries.push(String(text));
        return { rows: [] };
      }),
      end: vi.fn(async () => undefined),
    };
    const commands = [];
    const runCommand = vi.fn(async (command, arguments_, options) => {
      commands.push([command, arguments_]);
      if (command === 'pg_dump') {
        const dumpArgument = arguments_.find((argument) =>
          argument.startsWith('--file='),
        );
        await writeFile(dumpArgument.slice('--file='.length), 'custom dump');
      }
      if (command === 'restic' && arguments_[0] === 'backup') {
        const checksums = await readFile(
          path.join(options.cwd, 'checksums.sha256'),
          'utf8',
        );
        expect(checksums).toContain('database.dump');
        expect(checksums).toContain(`blobs/final/${blobKey}`);
        return {
          stdout:
            '{"message_type":"summary","snapshot_id":"restic-snapshot-123"}\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await createBackup(
      {
        ...validateBackupPaths(paths),
        databaseUrl: 'postgresql://journal:secret@localhost/journal',
        publicConfiguration: { backupFormatVersion: BACKUP_FORMAT_VERSION },
      },
      { createPool: () => pool, runCommand },
    );
    expect(result).toEqual({
      blobCount: 1,
      maxTombstoneGeneration: 7,
      repositorySnapshotId: 'restic-snapshot-123',
    });
    expect(
      commands.map(([command, arguments_]) => `${command} ${arguments_[0]}`),
    ).toEqual([
      'restic init',
      'pg_dump --format=custom',
      'restic backup',
      'restic check',
      'restic forget',
    ]);
    expect(queries.findIndex((query) => query === 'commit')).toBeLessThan(
      queries.findIndex((query) => query.includes('backup_checkpoint')),
    );
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(await readFile(blobPath, 'utf8')).toBe(blobBytes.toString('utf8'));
    expect(await readdirOrEmpty(paths.stagingDirectory)).toEqual([]);
  });

  it('[PORT-002][RET-006] refuses a corrupted restore before invoking pg_restore', async () => {
    const root = await temporaryDirectory('journal-backup-restore-');
    const paths = privatePaths(root);
    await mkdir(paths.repositoryDirectory, { recursive: true });
    await writeFile(
      path.join(paths.repositoryDirectory, 'config'),
      'repository',
    );
    await mkdir(path.dirname(paths.passwordFile), { recursive: true });
    await writeFile(paths.passwordFile, 'a'.repeat(64));
    const selectedFixture = path.join(root, 'selected-fixture');
    const latestFixture = path.join(root, 'latest-fixture');
    for (const fixture of [selectedFixture, latestFixture]) {
      await mkdir(fixture, { recursive: true });
      await writeFile(path.join(fixture, 'database.dump'), 'database');
      await writeFile(
        path.join(fixture, 'manifest.json'),
        JSON.stringify({
          formatVersion: BACKUP_FORMAT_VERSION,
          databaseDump: 'database.dump',
          blobs: [],
          pgBossSchemaVersion: EXPECTED_PG_BOSS_SCHEMA_VERSION,
          tombstoneCheckpoint: 'tombstones.jsonl',
        }),
      );
      await writeFile(path.join(fixture, 'tombstones.jsonl'), '');
      const files = ['database.dump', 'manifest.json', 'tombstones.jsonl'];
      const checksumLines = [];
      for (const file of files) {
        const digest = await sha256File(path.join(fixture, file));
        checksumLines.push(`${digest.sha256}  ${file}`);
      }
      await writeFile(
        path.join(fixture, 'checksums.sha256'),
        `${checksumLines.join('\n')}\n`,
      );
    }
    await writeFile(
      path.join(selectedFixture, 'database.dump'),
      'tampered database',
    );

    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      end: vi.fn(async () => undefined),
    };
    const commands = [];
    const runCommand = vi.fn(async (command, arguments_) => {
      commands.push([command, arguments_]);
      if (command === 'restic' && arguments_[0] === 'restore') {
        const target = arguments_[arguments_.indexOf('--target') + 1];
        const source =
          arguments_[1] === 'latest' ? latestFixture : selectedFixture;
        await copyDirectory(source, target);
      }
      return { stdout: '[]', stderr: '' };
    });

    await expect(
      restoreBackup(
        {
          ...validateBackupPaths({
            ...paths,
            blobDirectory: path.join(root, 'restored-blobs'),
          }),
          targetBlobDirectory: path.join(root, 'restored-blobs'),
          targetDatabaseUrl: 'postgresql://journal:secret@localhost/restored',
          snapshotId: 'selected-snapshot',
        },
        { createPool: () => pool, runCommand },
      ),
    ).rejects.toThrow(/Checksum validation failed/u);
    expect(commands.some(([command]) => command === 'pg_restore')).toBe(false);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('[PORT-001][PORT-002][RET-006][RET-007][SEARCH-006] applies a newer permanent-deletion checkpoint before restoring blobs, rebuilding search, or resuming work', async () => {
    const root = await temporaryDirectory('journal-backup-success-');
    const paths = privatePaths(root);
    await mkdir(paths.repositoryDirectory, { recursive: true });
    await writeFile(
      path.join(paths.repositoryDirectory, 'config'),
      'repository',
    );
    await mkdir(path.dirname(paths.passwordFile), { recursive: true });
    await writeFile(paths.passwordFile, 'a'.repeat(64));
    const selectedFixture = path.join(root, 'selected-fixture');
    const latestFixture = path.join(root, 'latest-fixture');
    await mkdir(selectedFixture, { recursive: true });
    await writeFile(path.join(selectedFixture, 'database.dump'), 'database');
    await writeFile(
      path.join(selectedFixture, 'manifest.json'),
      JSON.stringify({
        formatVersion: BACKUP_FORMAT_VERSION,
        databaseDump: 'database.dump',
        blobs: [],
        pgBossSchemaVersion: EXPECTED_PG_BOSS_SCHEMA_VERSION,
        tombstoneCheckpoint: 'tombstones.jsonl',
      }),
    );
    await writeFile(path.join(selectedFixture, 'tombstones.jsonl'), '');
    await writeFixtureChecksums(selectedFixture);
    await copyDirectory(selectedFixture, latestFixture);
    const tombstone = {
      id: '019c5b90-0000-7000-8000-000000000811',
      owner_id: '019c5b90-0000-7000-8000-000000000812',
      entity_kind: 'contribution',
      entity_id: '019c5b90-0000-7000-8000-000000000813',
      deleted_at: '2026-08-30T00:00:00.000Z',
      generation: 8,
      correlation_id: '019c5b90-0000-7000-8000-000000000814',
      created_at: '2026-08-30T00:00:00.000Z',
    };
    await writeFile(
      path.join(latestFixture, 'tombstones.jsonl'),
      `${JSON.stringify(tombstone)}\n`,
    );
    await writeFixtureChecksums(latestFixture);
    const queries = [];
    const queryCalls = [];
    const pool = {
      query: vi.fn(async (text, values) => {
        queries.push(String(text));
        queryCalls.push({ text: String(text), values });
        if (String(text).includes('from pgboss.version')) {
          return {
            rows: [{ version: EXPECTED_PG_BOSS_SCHEMA_VERSION }],
            rowCount: 1,
          };
        }
        if (String(text).includes('from pgboss.job')) {
          return { rows: [{ canceled: 2, resumed: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(async () => ({
        query: pool.query,
        release: vi.fn(),
      })),
      end: vi.fn(async () => undefined),
    };
    const commands = [];
    const runCommand = vi.fn(async (command, arguments_) => {
      commands.push([command, arguments_]);
      if (command === 'restic' && arguments_[0] === 'restore') {
        const target = arguments_[arguments_.indexOf('--target') + 1];
        await copyDirectory(
          arguments_[1] === 'latest' ? latestFixture : selectedFixture,
          target,
        );
      }
      return { stdout: '[]', stderr: '' };
    });
    const restoredBlobDirectory = path.join(root, 'restored-blobs');

    await expect(
      restoreBackup(
        {
          ...validateBackupPaths({
            ...paths,
            blobDirectory: restoredBlobDirectory,
          }),
          targetBlobDirectory: restoredBlobDirectory,
          targetDatabaseUrl: 'postgresql://journal:secret@localhost/restored',
          snapshotId: 'selected-snapshot',
        },
        { createPool: () => pool, runCommand },
      ),
    ).resolves.toEqual({
      restoredBlobCount: 0,
      tombstoneCount: 1,
      canceledJobCount: 2,
      resumedJobCount: 1,
    });
    expect(commands.map(([command]) => command)).toContain('pg_restore');
    const purge = queryCalls.find(({ text }) =>
      text.includes('journal.purge_contribution'),
    );
    expect(purge?.values).toEqual([tombstone.owner_id, tombstone.entity_id]);
    expect(
      queries.findIndex((query) =>
        query.includes('delete from journal.search_fragment'),
      ),
    ).toBeGreaterThan(
      queries.findIndex((query) => query.includes('retention_policy policy')),
    );
    expect(
      queries.findIndex((query) => query.includes('from pgboss.job')),
    ).toBeGreaterThan(
      queries.findIndex((query) =>
        query.includes('analyze journal.search_fragment'),
      ),
    );
  });

  it('[PORT-002][SEC-005] validates checksum paths and restore-only environment boundaries', async () => {
    expect(() => parseChecksumFile(`${'a'.repeat(64)}  ../secret\n`)).toThrow(
      BackupError,
    );
    const root = await temporaryDirectory('journal-backup-env-');
    const configuration = configurationFromEnvironment(
      {
        BACKUP_PASSWORD_FILE: path.join(root, 'secret', 'password'),
        BACKUP_REPOSITORY_DIR: path.join(root, 'repository'),
        BACKUP_STAGING_DIR: path.join(root, 'staging'),
        RESTORE_BLOB_DATA_DIR: path.join(root, 'restored-blobs'),
        RESTORE_DATABASE_URL: 'postgresql://journal@localhost/restored',
      },
      'restore',
    );
    expect(configuration.targetDatabaseUrl).toContain('/restored');
    expect(configuration).not.toHaveProperty('databaseUrl');
  });
});

async function readdirOrEmpty(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source)) {
    await copyFile(path.join(source, name), path.join(destination, name));
  }
}

async function writeFixtureChecksums(directory) {
  const checksumLines = [];
  for (const file of ['database.dump', 'manifest.json', 'tombstones.jsonl']) {
    const digest = await sha256File(path.join(directory, file));
    checksumLines.push(`${digest.sha256}  ${file}`);
  }
  await writeFile(
    path.join(directory, 'checksums.sha256'),
    `${checksumLines.join('\n')}\n`,
  );
}
