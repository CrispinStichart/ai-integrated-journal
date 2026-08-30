# Backup and restore

Task 49 implements PORT-001–PORT-002 with the local mechanism selected by
ADR-0009: PostgreSQL's custom dump format inside an encrypted `restic`
repository. The operator commands require compatible `pg_dump`/`pg_restore`
clients and `restic` on `PATH`. The PostgreSQL 17 client is recommended for the
local PostgreSQL 17 server.

## What a successful backup contains

One backup command holds a shared PostgreSQL backup/deletion fence and exports
a `REPEATABLE READ` snapshot. `pg_dump --format=custom` consumes that exact
snapshot and includes `journal`, `journal_migrations`, and the complete
`pgboss` schema. The same snapshot selects every database-referenced final
audio object, upload chunk, retained provider response, and hosted export.
Those files are copied in bounded-memory filesystem operations and checked
against their stored byte sizes and SHA-256 values.

The restic snapshot contains:

- `database.dump`;
- `blobs/final` and `blobs/staging` using opaque storage keys;
- `manifest.json` with format, migration, pg-boss, blob, and tombstone
  checkpoint metadata;
- `tombstones.jsonl`, the content-free anti-resurrection ledger;
- `configuration.json`, containing only allowlisted non-secret deployment
  metadata; and
- `checksums.sha256`, covering every preceding file.

Database passwords, the restic password, provider credentials, session
secrets, and recovery material are never written to the archive. The restic
password is a separately stored owner-only file.

A backup succeeds only after all source checksums match, restic creates the
snapshot, and `restic check` succeeds. Only then are pending permanent-deletion
tombstone checkpoints committed. The tool retains 7 daily, 5 weekly, and 12
monthly snapshots and runs `forget --prune`; encrypted deleted bytes can
therefore remain in historical snapshots for approximately one year.

## Configure and create backups

Choose three absolute, non-overlapping paths outside `BLOB_DATA_DIR`. Put the
repository on another device or filesystem for disaster recovery.

```sh
export BACKUP_REPOSITORY_DIR=/mnt/backup/ai-integrated-journal
export BACKUP_PASSWORD_FILE=/home/you/.config/ai-integrated-journal/restic.password
export BACKUP_STAGING_DIR=/home/you/.cache/ai-integrated-journal/backup-staging
corepack pnpm backup:init
corepack pnpm backup:create
```

`backup:init` creates a random 256-bit password when the password file does not
exist, applies `0700` directory and `0600` file modes, and initializes the
encrypted repository. Back up the password file separately; neither the
repository nor a journal export contains it. Losing it makes the repository
unrecoverable.

The seeded `backup.daily` pg-boss schedule is disabled by default. Once task 50
exposes policy management, enabling it runs at 03:30 UTC whenever the local
host and worker are available. A configured worker consumes only its
identifier-only schedule payload and invokes the same `backup:create` command.
Until then, use the command from a host scheduler if daily automation is
desired.

## Restore into empty targets

Stop the API and worker first. Restore never overwrites a live database or blob
directory. Create a new empty PostgreSQL database using the pgvector-capable
image, choose a nonexistent or empty blob directory, and provide the targets
through environment variables so database credentials do not appear in command
arguments.

```sh
export RESTORE_DATABASE_URL=postgresql://journal:password@127.0.0.1:5432/journal_restore
export RESTORE_BLOB_DATA_DIR=/home/you/.local/share/ai-integrated-journal-restored/blobs
# Optional; defaults to the latest compatible tagged snapshot.
export BACKUP_SNAPSHOT_ID=latest
corepack pnpm backup:restore
```

Restore performs these gates before the application may start:

1. Prove the target has no `journal`, `journal_migrations`, or `pgboss` schema
   and that the target blob directory is empty.
2. Restore and validate every selected-snapshot checksum before invoking
   `pg_restore`.
3. Load the newest tombstone checkpoint available in the repository, validate
   its checksum, append it to the restored ledger, and purge any matching
   restored material. A checkpoint owner missing from the selected database is
   an integrity failure, not silently ignored.
4. Rebuild all current lexical fragments from canonical contributions,
   transcripts, artifacts, and memories. Existing vectors are discarded;
   lifecycle triggers create pending embedding requests for safe provider-cohort
   reindexing.
5. Restore only blobs still referenced after tombstone replay, checking size and
   SHA-256 again at the destination. Selected historical blobs covered by later
   tombstones are not copied.
6. Reject unvalidated PostgreSQL constraints and reconcile nonterminal pg-boss
   work. Active required jobs become retryable; jobs whose canonical run,
   request, revision, deletion, or export state no longer requires work are
   removed. Workers still reload canonical state on every attempt.

If both a deletion and every checkpoint recording it are newer than the
available media, that media cannot prove a post-deletion restore. It must not be
described as verified. Never start the API or worker against a partially
restored target.

## Restore drill

Run this drill at least quarterly and after changing PostgreSQL, pg-boss,
restic, the schema, or backup tooling:

1. Run `backup:create` and record its content-free restic snapshot ID.
2. Provision a disposable empty PostgreSQL database and empty blob directory.
3. Set `BACKUP_SNAPSHOT_ID`, `RESTORE_DATABASE_URL`, and
   `RESTORE_BLOB_DATA_DIR`, then run `backup:restore`.
4. Start a disposable API/worker pair on the restored targets. Verify readiness,
   a representative Journal Day, audio playback, lexical search, and that
   optional semantic indexing progresses from pending.
5. Confirm a permanently deleted fixture remains absent and its tombstone
   remains present.
6. Destroy only the explicitly named disposable targets after recording the
   date, tool versions, snapshot ID, and outcome. Never point the drill at live
   paths.

The automated unit and PostgreSQL integration suites cover path/secret policy,
snapshot ordering, checksums, corruption refusal, checkpoint gating, restore
ordering, search rebuild invocation, and canonical job reconciliation. The
quarterly drill additionally validates the installed external binaries and
recovery media.
