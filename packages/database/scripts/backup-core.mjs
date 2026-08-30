import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import pg from 'pg';

const { Pool } = pg;

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_TAG = 'ai-integrated-journal-v1';
export const BACKUP_LOCK_NAME = 'journal.backup-deletion-fence';
export const EXPECTED_PG_BOSS_SCHEMA_VERSION = 37;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupError';
  }
}

function assertAbsolute(name, value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new BackupError(`${name} must be an absolute path.`);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new BackupError(`${name} cannot be a filesystem root.`);
  }
  return resolved;
}

function overlaps(left, right) {
  return (
    left === right ||
    left.startsWith(`${right}${path.sep}`) ||
    right.startsWith(`${left}${path.sep}`)
  );
}

export function validateBackupPaths(input) {
  const blobDirectory = assertAbsolute('BLOB_DATA_DIR', input.blobDirectory);
  const repositoryDirectory = assertAbsolute(
    'BACKUP_REPOSITORY_DIR',
    input.repositoryDirectory,
  );
  const stagingDirectory = assertAbsolute(
    'BACKUP_STAGING_DIR',
    input.stagingDirectory,
  );
  const passwordFile = assertAbsolute(
    'BACKUP_PASSWORD_FILE',
    input.passwordFile,
  );
  for (const [leftName, left, rightName, right] of [
    [
      'BACKUP_REPOSITORY_DIR',
      repositoryDirectory,
      'BLOB_DATA_DIR',
      blobDirectory,
    ],
    ['BACKUP_STAGING_DIR', stagingDirectory, 'BLOB_DATA_DIR', blobDirectory],
    [
      'BACKUP_STAGING_DIR',
      stagingDirectory,
      'BACKUP_REPOSITORY_DIR',
      repositoryDirectory,
    ],
  ]) {
    if (overlaps(left, right)) {
      throw new BackupError(`${leftName} and ${rightName} must not overlap.`);
    }
  }
  if (
    overlaps(passwordFile, repositoryDirectory) ||
    overlaps(passwordFile, blobDirectory)
  ) {
    throw new BackupError(
      'BACKUP_PASSWORD_FILE must be outside the repository and live blob directory.',
    );
  }
  return Object.freeze({
    blobDirectory,
    repositoryDirectory,
    stagingDirectory,
    passwordFile,
  });
}

export function assertBlobKey(key) {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.includes('\\') ||
    key.includes('\0') ||
    key.split('/').some((segment) => !SAFE_KEY_SEGMENT.test(segment))
  ) {
    throw new BackupError('A database blob key is not a canonical opaque key.');
  }
  return key;
}

function databaseEnvironment(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new BackupError('The database URL is invalid.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new BackupError('The database URL must use PostgreSQL.');
  }
  const databaseName = parsed.pathname.replace(/^\//u, '');
  if (databaseName.length === 0)
    throw new BackupError('The database name is missing.');
  return {
    PGDATABASE: decodeURIComponent(databaseName),
    PGHOST: decodeURIComponent(parsed.hostname),
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    ...(parsed.password.length === 0
      ? {}
      : { PGPASSWORD: decodeURIComponent(parsed.password) }),
    ...(parsed.searchParams.get('sslmode') === null
      ? {}
      : { PGSSLMODE: parsed.searchParams.get('sslmode') }),
  };
}

export function publicConfiguration(environment) {
  const parsed = new URL(environment.DATABASE_URL);
  return Object.freeze({
    appEnvironment: environment.APP_ENV ?? 'development',
    authOrigin: environment.AUTH_ORIGIN ?? 'http://localhost:5173',
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    database: {
      database: decodeURIComponent(parsed.pathname.replace(/^\//u, '')),
      host: parsed.hostname,
      port: parsed.port || '5432',
    },
    journalBlobLayout: 'local-v1',
    webauthnRelyingPartyId: environment.WEBAUTHN_RP_ID ?? 'localhost',
  });
}

export async function sha256File(filePath) {
  const digest = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
    byteSize += chunk.byteLength;
  }
  return { byteSize, sha256: digest.digest('hex') };
}

async function writePrivate(filePath, value) {
  await writeFile(filePath, value, { encoding: 'utf8', mode: FILE_MODE });
  await chmod(filePath, FILE_MODE);
}

export async function runCommand(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => reject(error));
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(
          new BackupError(
            `${command} failed (${signal ?? `exit ${String(code)}`}): ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        );
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function resticEnvironment(configuration) {
  return {
    ...process.env,
    RESTIC_PASSWORD_FILE: configuration.passwordFile,
    RESTIC_REPOSITORY: configuration.repositoryDirectory,
  };
}

async function ensureOwnerOnlyDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(directory, DIRECTORY_MODE);
}

export async function initializeRepository(configuration, dependencies = {}) {
  const execute = dependencies.runCommand ?? runCommand;
  await ensureOwnerOnlyDirectory(configuration.repositoryDirectory);
  await ensureOwnerOnlyDirectory(configuration.stagingDirectory);
  await ensureOwnerOnlyDirectory(path.dirname(configuration.passwordFile));
  try {
    const metadata = await lstat(configuration.passwordFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new BackupError('The backup password path must be a regular file.');
    }
    await chmod(configuration.passwordFile, FILE_MODE);
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT'))
      throw error;
    const handle = await open(configuration.passwordFile, 'wx', FILE_MODE);
    try {
      await handle.writeFile(`${randomBytes(32).toString('hex')}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const entries = await readdir(configuration.repositoryDirectory);
  if (entries.length === 0) {
    await execute('restic', ['init'], {
      env: resticEnvironment(configuration),
    });
  } else {
    await execute('restic', ['snapshots', '--json'], {
      env: resticEnvironment(configuration),
    });
  }
}

const BLOB_QUERY = `
  select storage_area, blob_key, byte_size::text, sha256 from (
    select 'final' storage_area, r.final_blob_key blob_key,
      r.final_byte_size byte_size, r.final_sha256 sha256
    from journal.recording r
    join journal.contribution contribution on contribution.id = r.contribution_id
    join journal.journal_day day on day.id = contribution.journal_day_id
    where r.final_blob_key is not null and r.final_byte_size is not null
      and r.final_sha256 is not null
      and not exists (
        select 1 from journal.deletion_tombstone tombstone
        where tombstone.owner_id = day.user_id and (
          (tombstone.entity_kind = 'recording_audio' and tombstone.entity_id = r.id) or
          (tombstone.entity_kind = 'contribution' and tombstone.entity_id = contribution.id) or
          (tombstone.entity_kind = 'journal_day' and tombstone.entity_id = day.id)
        )
      )
    union all
    select 'staging', chunk.staging_blob_key, chunk.byte_size, chunk.sha256
    from journal.recording_chunk chunk
    join journal.recording_upload upload on upload.id = chunk.upload_id
    join journal.recording recording on recording.id = upload.recording_id
    join journal.contribution contribution on contribution.id = recording.contribution_id
    join journal.journal_day day on day.id = contribution.journal_day_id
    where not exists (
      select 1 from journal.deletion_tombstone tombstone
      where tombstone.owner_id = day.user_id and (
        (tombstone.entity_kind = 'recording_audio' and tombstone.entity_id = recording.id) or
        (tombstone.entity_kind = 'contribution' and tombstone.entity_id = contribution.id) or
        (tombstone.entity_kind = 'journal_day' and tombstone.entity_id = day.id)
      )
    )
    union all
    select 'final', raw.blob_key, raw.byte_size, raw.sha256 from (
      select raw_response_blob_key blob_key, raw_response_byte_size byte_size,
        raw_response_sha256 sha256 from journal.transcription_run
      union all select raw_response_blob_key, raw_response_byte_size,
        raw_response_sha256 from journal.transcript_cleanup_run
      union all select raw_response_blob_key, raw_response_byte_size,
        raw_response_sha256 from journal.processor_run
      union all select raw_response_blob_key, raw_response_byte_size,
        raw_response_sha256 from journal.grounded_answer
    ) raw where raw.blob_key is not null and raw.byte_size is not null
      and raw.sha256 is not null
    union all
    select 'final', archive_blob_key, archive_byte_size, archive_sha256
    from journal.export_request
    where archive_blob_key is not null and archive_byte_size is not null
      and archive_sha256 is not null and status = 'completed'
  ) blobs order by storage_area, blob_key
`;

function normalizedBlobRows(rows) {
  const unique = new Map();
  for (const row of rows) {
    const storageArea = row.storage_area;
    if (!['final', 'staging'].includes(storageArea)) {
      throw new BackupError(
        'The database referenced an unknown blob storage area.',
      );
    }
    const key = assertBlobKey(row.blob_key);
    const byteSize = Number(row.byte_size);
    if (
      !Number.isSafeInteger(byteSize) ||
      byteSize < 0 ||
      !SHA256_PATTERN.test(row.sha256)
    ) {
      throw new BackupError(
        'The database contains invalid blob integrity metadata.',
      );
    }
    const identity = `${storageArea}/${key}`;
    const existing = unique.get(identity);
    const normalized = { storageArea, key, byteSize, sha256: row.sha256 };
    if (
      existing &&
      (existing.byteSize !== normalized.byteSize ||
        existing.sha256 !== normalized.sha256)
    ) {
      throw new BackupError(
        'One blob key has conflicting database integrity metadata.',
      );
    }
    unique.set(identity, normalized);
  }
  return [...unique.values()];
}

async function copyVerifiedBlob(blobDirectory, runDirectory, blob) {
  const source = path.join(
    blobDirectory,
    blob.storageArea,
    ...blob.key.split('/'),
  );
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    throw new BackupError(
      `Blob ${blob.storageArea}/${blob.key} is not a regular file.`,
    );
  }
  const destination = path.join(
    runDirectory,
    'blobs',
    blob.storageArea,
    ...blob.key.split('/'),
  );
  await ensureOwnerOnlyDirectory(path.dirname(destination));
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  await chmod(destination, FILE_MODE);
  const actual = await sha256File(destination);
  if (actual.byteSize !== blob.byteSize || actual.sha256 !== blob.sha256) {
    throw new BackupError(
      `Blob ${blob.storageArea}/${blob.key} failed checksum validation.`,
    );
  }
  return `blobs/${blob.storageArea}/${blob.key}`;
}

async function writeChecksums(runDirectory, relativePaths) {
  const lines = [];
  for (const relativePath of [...relativePaths].sort()) {
    const digest = await sha256File(path.join(runDirectory, relativePath));
    lines.push(`${digest.sha256}  ${relativePath}`);
  }
  await writePrivate(
    path.join(runDirectory, 'checksums.sha256'),
    `${lines.join('\n')}\n`,
  );
}

export function parseChecksumFile(value) {
  const result = new Map();
  for (const line of value.split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]{64})[ ]{2}(.+)$/u.exec(line);
    if (!match) throw new BackupError('The backup checksum file is malformed.');
    const checksum = match[1];
    const relativePath = match[2];
    if (
      path.isAbsolute(relativePath) ||
      relativePath
        .split('/')
        .some(
          (segment) => segment === '' || segment === '..' || segment === '.',
        )
    ) {
      throw new BackupError(
        'The backup checksum file contains an unsafe path.',
      );
    }
    if (result.has(relativePath))
      throw new BackupError('The backup checksum file has duplicates.');
    result.set(relativePath, checksum);
  }
  return result;
}

export async function validateChecksums(root, onlyPath) {
  const checksums = parseChecksumFile(
    await readFile(path.join(root, 'checksums.sha256'), 'utf8'),
  );
  const entries =
    onlyPath === undefined
      ? checksums
      : new Map([[onlyPath, checksums.get(onlyPath)]]);
  for (const [relativePath, expected] of entries) {
    if (expected === undefined)
      throw new BackupError(`No checksum exists for ${relativePath}.`);
    const actual = await sha256File(path.join(root, relativePath));
    if (actual.sha256 !== expected)
      throw new BackupError(`Checksum validation failed for ${relativePath}.`);
  }
  return checksums.size;
}

function snapshotIdFromRestic(output) {
  const records = output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    });
  const summary = records.findLast(
    (record) => record?.message_type === 'summary',
  );
  if (
    typeof summary?.snapshot_id !== 'string' ||
    summary.snapshot_id.length === 0
  ) {
    throw new BackupError('restic did not report a snapshot identifier.');
  }
  return summary.snapshot_id;
}

export async function createBackup(configuration, dependencies = {}) {
  const execute = dependencies.runCommand ?? runCommand;
  const createPool =
    dependencies.createPool ??
    ((url) => new Pool({ connectionString: url, max: 2 }));
  await initializeRepository(configuration, { runCommand: execute });
  const pool = createPool(configuration.databaseUrl);
  const client = await pool.connect();
  let locked = false;
  let runDirectory;
  try {
    await client.query(
      'select pg_advisory_lock_shared(hashtextextended($1, 0))',
      [BACKUP_LOCK_NAME],
    );
    locked = true;
    await client.query('begin isolation level repeatable read read only');
    const snapshot = await client.query(
      'select pg_export_snapshot() snapshot_id, clock_timestamp() snapshot_at',
    );
    const snapshotId = snapshot.rows[0]?.snapshot_id;
    const snapshotAt = snapshot.rows[0]?.snapshot_at;
    if (typeof snapshotId !== 'string' || snapshotAt === undefined) {
      throw new BackupError('PostgreSQL did not export a backup snapshot.');
    }
    const blobResult = await client.query(BLOB_QUERY);
    const tombstoneResult = await client.query(
      `select id::text, owner_id::text, entity_kind, entity_id::text,
        deleted_at, generation, correlation_id::text, created_at
        from journal.deletion_tombstone order by owner_id, generation`,
    );
    const bossVersionResult = await client.query(
      'select version from pgboss.version limit 1',
    );
    const migrationResult = await client.query(
      `select coalesce(max(id), 0)::text migration_id
       from journal_migrations.__drizzle_migrations`,
    );
    const blobs = normalizedBlobRows(blobResult.rows);
    await ensureOwnerOnlyDirectory(configuration.stagingDirectory);
    runDirectory = await mkdtemp(
      path.join(configuration.stagingDirectory, 'backup-'),
    );
    await chmod(runDirectory, DIRECTORY_MODE);
    const dumpPath = path.join(runDirectory, 'database.dump');
    await execute(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        `--snapshot=${snapshotId}`,
        '--schema=journal',
        '--schema=journal_migrations',
        '--schema=pgboss',
        `--file=${dumpPath}`,
      ],
      {
        env: {
          ...process.env,
          ...databaseEnvironment(configuration.databaseUrl),
        },
      },
    );
    await chmod(dumpPath, FILE_MODE);
    await client.query('commit');

    const blobPaths = [];
    for (const blob of blobs) {
      blobPaths.push(
        await copyVerifiedBlob(configuration.blobDirectory, runDirectory, blob),
      );
    }
    const tombstones = tombstoneResult.rows
      .map((row) => JSON.stringify(row))
      .join('\n');
    await writePrivate(
      path.join(runDirectory, 'tombstones.jsonl'),
      tombstones.length === 0 ? '' : `${tombstones}\n`,
    );
    await writePrivate(
      path.join(runDirectory, 'configuration.json'),
      `${JSON.stringify(configuration.publicConfiguration, null, 2)}\n`,
    );
    const maxTombstoneGeneration = tombstoneResult.rows.reduce(
      (maximum, row) => Math.max(maximum, Number(row.generation)),
      0,
    );
    const manifest = {
      blobCount: blobs.length,
      blobs,
      createdAt: new Date(snapshotAt).toISOString(),
      databaseDump: 'database.dump',
      formatVersion: BACKUP_FORMAT_VERSION,
      maxTombstoneGeneration,
      migrationId: migrationResult.rows[0]?.migration_id ?? '0',
      pgBossSchemaVersion: Number(bossVersionResult.rows[0]?.version),
      tombstoneCheckpoint: 'tombstones.jsonl',
    };
    await writePrivate(
      path.join(runDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await writeChecksums(runDirectory, [
      'configuration.json',
      'database.dump',
      'manifest.json',
      'tombstones.jsonl',
      ...blobPaths,
    ]);
    const restic = await execute(
      'restic',
      [
        'backup',
        '--json',
        '--tag',
        BACKUP_TAG,
        '--host',
        'ai-integrated-journal',
        '--',
        '.',
      ],
      { cwd: runDirectory, env: resticEnvironment(configuration) },
    );
    const repositorySnapshotId = snapshotIdFromRestic(restic.stdout);
    await execute('restic', ['check'], {
      env: resticEnvironment(configuration),
    });
    if (maxTombstoneGeneration > 0) {
      await pool.query(
        `with checkpointed as (
           update journal.permanent_deletion_request
           set backup_checkpoint = 'committed', updated_at = now()
           where backup_checkpoint = 'pending' and generation <= $1
           returning id
         )
         update pgboss.job job
         set state = 'retry', start_after = now(), started_on = null,
             completed_on = null, output = null
         where job.data->>'operation' = 'retention_request'
           and job.data->'identifiers'->>'requestId' in
             (select id::text from checkpointed)
           and job.state <> 'active'`,
        [maxTombstoneGeneration],
      );
    }
    await execute(
      'restic',
      [
        'forget',
        '--tag',
        BACKUP_TAG,
        '--group-by',
        'host,tags',
        '--keep-daily',
        '7',
        '--keep-weekly',
        '5',
        '--keep-monthly',
        '12',
        '--prune',
      ],
      { env: resticEnvironment(configuration) },
    );
    return Object.freeze({
      blobCount: blobs.length,
      repositorySnapshotId,
      maxTombstoneGeneration,
    });
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Preserve the original backup failure.
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await client.query(
          'select pg_advisory_unlock_shared(hashtextextended($1, 0))',
          [BACKUP_LOCK_NAME],
        );
      } catch {
        // Closing the connection releases the session lock.
      }
    }
    client.release();
    await pool.end();
    if (runDirectory !== undefined)
      await rm(runDirectory, { recursive: true, force: true });
  }
}

async function assertEmptyRestoreTarget(pool, blobDirectory) {
  const schemas = await pool.query(
    `select nspname from pg_namespace where nspname in ('journal', 'journal_migrations', 'pgboss')`,
  );
  if (schemas.rowCount !== 0)
    throw new BackupError('The restore database target is not empty.');
  try {
    const entries = await readdir(blobDirectory);
    if (entries.length !== 0)
      throw new BackupError('The restore blob target is not empty.');
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT'))
      throw error;
  }
}

async function parseTombstones(filePath) {
  const value = await readFile(filePath, 'utf8');
  return value
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const record = JSON.parse(line);
      if (
        typeof record.id !== 'string' ||
        typeof record.owner_id !== 'string' ||
        typeof record.entity_id !== 'string' ||
        typeof record.generation !== 'number' ||
        ![
          'journal_day',
          'contribution',
          'recording_audio',
          'provider_raw_response',
        ].includes(record.entity_kind)
      ) {
        throw new BackupError('The tombstone checkpoint is malformed.');
      }
      return record;
    });
}

async function applyTombstones(pool, tombstones) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const tombstone of tombstones) {
      await client.query(
        `insert into journal.deletion_tombstone
          (id, owner_id, entity_kind, entity_id, deleted_at, generation,
           correlation_id, created_at)
         values ($1::uuid, $2::uuid, $3::journal.retention_entity_kind,
           $4::uuid, $5::timestamptz, $6::integer, $7::uuid, $8::timestamptz)
         on conflict (owner_id, entity_kind, entity_id) do nothing`,
        [
          tombstone.id,
          tombstone.owner_id,
          tombstone.entity_kind,
          tombstone.entity_id,
          tombstone.deleted_at,
          tombstone.generation,
          tombstone.correlation_id,
          tombstone.created_at,
        ],
      );
    }
    const ordered = [...tombstones].sort((left, right) => {
      const priority = {
        journal_day: 0,
        contribution: 1,
        recording_audio: 2,
        provider_raw_response: 3,
      };
      return priority[left.entity_kind] - priority[right.entity_kind];
    });
    for (const tombstone of ordered) {
      if (tombstone.entity_kind === 'journal_day') {
        await client.query(
          `select journal.purge_journal_day($1::uuid, $2::uuid)
           where exists (select 1 from journal.journal_day where id = $2::uuid and user_id = $1::uuid)`,
          [tombstone.owner_id, tombstone.entity_id],
        );
      } else if (tombstone.entity_kind === 'contribution') {
        await client.query(
          `select journal.purge_contribution($1::uuid, $2::uuid)
           where exists (select 1 from journal.contribution c join journal.journal_day d
             on d.id = c.journal_day_id where c.id = $2::uuid and d.user_id = $1::uuid)`,
          [tombstone.owner_id, tombstone.entity_id],
        );
      } else if (tombstone.entity_kind === 'recording_audio') {
        await client.query(
          `select journal.purge_recording_audio($1::uuid, $2::uuid, $3::timestamptz)
           where exists (select 1 from journal.recording r join journal.contribution c
             on c.id = r.contribution_id join journal.journal_day d on d.id = c.journal_day_id
             where r.id = $2::uuid and d.user_id = $1::uuid)`,
          [tombstone.owner_id, tombstone.entity_id, tombstone.deleted_at],
        );
      } else {
        await client.query(
          'select journal.purge_provider_raw_response($1::uuid, $2::uuid)',
          [tombstone.owner_id, tombstone.entity_id],
        );
      }
    }
    await client.query(`update journal.retention_policy policy set deletion_generation = source.maximum
      from (select owner_id, max(generation) maximum from journal.deletion_tombstone group by owner_id) source
      where policy.owner_id = source.owner_id and policy.deletion_generation < source.maximum`);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function rebuildSearch(pool) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from journal.search_fragment');
    await client.query(
      'select journal.refresh_contribution_search(id) from journal.contribution',
    );
    await client.query(
      'select journal.refresh_transcript_search(id) from journal.transcript',
    );
    await client.query(
      'select journal.refresh_artifact_search(id) from journal.processor_artifact',
    );
    await client.query(
      'select journal.refresh_memory_search(id) from journal.memory',
    );
    await client.query('analyze journal.search_fragment');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export const RESTORE_JOB_RECONCILIATION_SQL = `
  with candidates as (
    select id, name, data, state from pgboss.job
    where state in ('created', 'retry', 'active')
  ), required as (
    select candidate.id from candidates candidate
    where
      (candidate.data->>'operation' = 'transcribe_recording' and exists (
        select 1 from journal.transcription_run run
        join journal.recording recording on recording.id = run.recording_id
        where run.id::text = candidate.data->'identifiers'->>'runId'
          and (run.status in ('queued', 'running') or
            (run.status = 'failed' and run.error_retryable = true))
          and recording.latest_transcription_run_id = run.id
          and recording.audio_deleted_at is null
      )) or
      (candidate.data->>'operation' = 'clean_transcript' and exists (
        select 1 from journal.transcript_cleanup_run run
        join journal.transcript_revision revision on revision.id = run.source_corrected_revision_id
        join journal.transcript transcript on transcript.id = revision.transcript_id
        where run.id::text = candidate.data->'identifiers'->>'cleanupRunId'
          and (run.status in ('queued', 'running') or
            (run.status = 'failed' and run.error_retryable = true))
          and transcript.current_revision_id = revision.id
      )) or
      (candidate.data->>'operation' = 'execute_processor' and exists (
        select 1 from journal.processor_run run
        where run.id::text = candidate.data->'identifiers'->>'runId'
          and (run.status in ('queued', 'running') or
            (run.status = 'failed' and run.error_retryable = true))
      )) or
      (candidate.data->>'operation' = 'grounded_answer' and exists (
        select 1 from journal.grounded_answer answer
        where answer.id::text = candidate.data->'identifiers'->>'answerId'
          and answer.job_id = candidate.id and answer.status in ('queued', 'running')
      )) or
      (candidate.data->>'operation' = 'export' and exists (
        select 1 from journal.export_request request
        where request.id::text = candidate.data->'identifiers'->>'exportId'
          and request.status in ('queued', 'running') and request.invalidated_at is null
      )) or
      (candidate.data->>'operation' = 'retention_request' and exists (
        select 1 from journal.permanent_deletion_request request
        where request.id::text = candidate.data->'identifiers'->>'requestId'
          and request.status <> 'completed'
      )) or
      (candidate.data->>'operation' in ('retention', 'nudge_digest', 'search_embedding_dispatch'))
  ), canceled as (
    delete from pgboss.job job using candidates candidate
    where job.id = candidate.id and not exists (select 1 from required where required.id = candidate.id)
    returning job.id
  ), resumed as (
    update pgboss.job job set state = 'retry', start_after = now(), started_on = null
    from required where job.id = required.id and job.state = 'active'
    returning job.id
  )
  select (select count(*)::integer from canceled) canceled,
         (select count(*)::integer from resumed) resumed
`;

async function validateDatabase(pool) {
  const bossVersion = await pool.query(
    'select version::integer from pgboss.version limit 1',
  );
  if (
    Number(bossVersion.rows[0]?.version) !== EXPECTED_PG_BOSS_SCHEMA_VERSION
  ) {
    throw new BackupError(
      'The restored pg-boss schema version is unsupported.',
    );
  }
  const constraints = await pool.query(
    `select conname from pg_constraint where connamespace in
      ('journal'::regnamespace, 'pgboss'::regnamespace) and not convalidated`,
  );
  if (constraints.rowCount !== 0)
    throw new BackupError('The restored database has unvalidated constraints.');
  const reconciliation = await pool.query(RESTORE_JOB_RECONCILIATION_SQL);
  return reconciliation.rows[0] ?? { canceled: 0, resumed: 0 };
}

async function restoreBlobs(
  selectedRoot,
  targetBlobDirectory,
  manifest,
  liveRows,
) {
  const live = new Set(
    normalizedBlobRows(liveRows).map(
      (blob) => `${blob.storageArea}/${blob.key}`,
    ),
  );
  await ensureOwnerOnlyDirectory(targetBlobDirectory);
  await Promise.all([
    ensureOwnerOnlyDirectory(path.join(targetBlobDirectory, 'final')),
    ensureOwnerOnlyDirectory(path.join(targetBlobDirectory, 'staging')),
    ensureOwnerOnlyDirectory(path.join(targetBlobDirectory, 'temporary')),
  ]);
  let restored = 0;
  for (const blob of manifest.blobs) {
    const identity = `${blob.storageArea}/${blob.key}`;
    if (!live.has(identity)) continue;
    const source = path.join(
      selectedRoot,
      'blobs',
      blob.storageArea,
      ...assertBlobKey(blob.key).split('/'),
    );
    const destination = path.join(
      targetBlobDirectory,
      blob.storageArea,
      ...blob.key.split('/'),
    );
    await ensureOwnerOnlyDirectory(path.dirname(destination));
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    await chmod(destination, FILE_MODE);
    const digest = await sha256File(destination);
    if (digest.byteSize !== blob.byteSize || digest.sha256 !== blob.sha256) {
      throw new BackupError(
        `Restored blob ${identity} failed integrity validation.`,
      );
    }
    restored += 1;
    live.delete(identity);
  }
  if (live.size !== 0)
    throw new BackupError(
      'The backup is missing a blob still referenced after tombstone replay.',
    );
  return restored;
}

export async function restoreBackup(configuration, dependencies = {}) {
  const execute = dependencies.runCommand ?? runCommand;
  const createPool =
    dependencies.createPool ??
    ((url) => new Pool({ connectionString: url, max: 2 }));
  await initializeRepository(configuration, { runCommand: execute });
  await ensureOwnerOnlyDirectory(configuration.stagingDirectory);
  const workspace = await mkdtemp(
    path.join(configuration.stagingDirectory, 'restore-'),
  );
  await chmod(workspace, DIRECTORY_MODE);
  const selectedRoot = path.join(workspace, 'selected');
  const latestRoot = path.join(workspace, 'latest');
  const pool = createPool(configuration.targetDatabaseUrl);
  try {
    await assertEmptyRestoreTarget(pool, configuration.targetBlobDirectory);
    await execute(
      'restic',
      [
        'restore',
        configuration.snapshotId ?? 'latest',
        '--tag',
        BACKUP_TAG,
        '--target',
        selectedRoot,
      ],
      {
        env: resticEnvironment(configuration),
      },
    );
    await validateChecksums(selectedRoot);
    const manifest = JSON.parse(
      await readFile(path.join(selectedRoot, 'manifest.json'), 'utf8'),
    );
    if (
      manifest.formatVersion !== BACKUP_FORMAT_VERSION ||
      manifest.databaseDump !== 'database.dump' ||
      manifest.tombstoneCheckpoint !== 'tombstones.jsonl' ||
      manifest.pgBossSchemaVersion !== EXPECTED_PG_BOSS_SCHEMA_VERSION ||
      !Array.isArray(manifest.blobs)
    ) {
      throw new BackupError(
        'The selected backup manifest version is unsupported.',
      );
    }
    await execute(
      'restic',
      [
        'restore',
        'latest',
        '--tag',
        BACKUP_TAG,
        '--include',
        '/tombstones.jsonl',
        '--include',
        '/checksums.sha256',
        '--target',
        latestRoot,
      ],
      {
        env: resticEnvironment(configuration),
      },
    );
    await validateChecksums(latestRoot, 'tombstones.jsonl');
    await pool.query('create extension if not exists vector');
    await execute(
      'pg_restore',
      [
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        path.join(selectedRoot, manifest.databaseDump),
      ],
      {
        env: {
          ...process.env,
          ...databaseEnvironment(configuration.targetDatabaseUrl),
        },
      },
    );
    const newestTombstones = await parseTombstones(
      path.join(latestRoot, 'tombstones.jsonl'),
    );
    await applyTombstones(pool, newestTombstones);
    await rebuildSearch(pool);
    const liveBlobRows = (await pool.query(BLOB_QUERY)).rows;
    const restoredBlobCount = await restoreBlobs(
      selectedRoot,
      configuration.targetBlobDirectory,
      manifest,
      liveBlobRows,
    );
    const jobs = await validateDatabase(pool);
    return Object.freeze({
      restoredBlobCount,
      tombstoneCount: newestTombstones.length,
      canceledJobCount: Number(jobs.canceled),
      resumedJobCount: Number(jobs.resumed),
    });
  } finally {
    await pool.end();
    await rm(workspace, { recursive: true, force: true });
  }
}

export function configurationFromEnvironment(environment, mode) {
  const paths = validateBackupPaths({
    blobDirectory:
      mode === 'restore'
        ? environment.RESTORE_BLOB_DATA_DIR
        : environment.BLOB_DATA_DIR,
    repositoryDirectory: environment.BACKUP_REPOSITORY_DIR,
    stagingDirectory: environment.BACKUP_STAGING_DIR,
    passwordFile: environment.BACKUP_PASSWORD_FILE,
  });
  if (mode === 'restore') {
    if (environment.RESTORE_DATABASE_URL === undefined) {
      throw new BackupError('RESTORE_DATABASE_URL is required.');
    }
    return {
      ...paths,
      targetBlobDirectory: paths.blobDirectory,
      targetDatabaseUrl: environment.RESTORE_DATABASE_URL,
      snapshotId: environment.BACKUP_SNAPSHOT_ID,
    };
  }
  if (environment.DATABASE_URL === undefined)
    throw new BackupError('DATABASE_URL is required.');
  return {
    ...paths,
    databaseUrl: environment.DATABASE_URL,
    publicConfiguration: publicConfiguration(environment),
  };
}
