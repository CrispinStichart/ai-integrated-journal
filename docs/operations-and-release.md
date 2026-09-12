# Operations and release runbook

This is the operator runbook for the supported private, single-owner localhost
release. It covers startup, ownership, forward upgrades, providers, lifecycle
operations, troubleshooting, and recovery. Product conformance evidence is in
the [final requirement-to-test report](requirement-to-test-matrix.md).

## Install once and configure

Prerequisites are Node.js 24.18.0, Corepack, pnpm 11.22.0 through Corepack, and
Docker with Compose. Install the locked dependency graph, then configure the
protected local environment:

```sh
corepack pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
corepack pnpm local:start -- --check
```

Replace the database password and absolute blob path before the check. See the
complete [configuration reference](configuration.md). The check validates
configuration without printing values and verifies that Docker is reachable.

## One-command local startup

From a configured checkout, one command starts PostgreSQL, creates owner-only
blob directories, applies every forward migration, reconciles idempotent seeds
and pg-boss queues/schedules, then runs the API, worker, and web development
server:

```sh
corepack pnpm local:start
```

The preflight completes before infrastructure is changed. Preparation stops on
the first failure, and application processes do not start against a partially
migrated or unseeded database. To prepare without keeping application processes
open, run `corepack pnpm local:start -- --prepare-only`. To inspect the ordered
command plan without executing it, run
`corepack pnpm local:start -- --dry-run`.

The local web origin is `http://localhost:5173`; the API listens on loopback port
3000 by default. `/health/live` proves the API event loop responds,
`/health/ready` requires PostgreSQL and blob storage, and authenticated
`/health/details` reports dependency, migration, queue, storage, and provider
state without content. Readiness deliberately does not depend on an AI provider.

Use `Ctrl+C` to stop the three watch processes. PostgreSQL remains running and
its named volume remains intact. Stop it without deleting data with:

```sh
corepack pnpm infra:down
```

Never add `--volumes` unless destruction of the explicitly named local database
is intended and a validated recovery point exists.

## Durable data and ownership

| Data | Location/owner | Lifecycle |
| --- | --- | --- |
| PostgreSQL application, migration, pg-boss, and search state | Docker volume `ai-integrated-journal-postgres-data`, owned inside the PostgreSQL container | Authoritative structured state. `infra:down` retains it. Do not edit tables or queue rows manually. |
| Original audio, staging chunks, provider bodies, and hosted exports | Opaque keys below `BLOB_DATA_DIR`, readable/writable only by the application OS account | Authoritative bytes referenced by PostgreSQL. Do not rename, deduplicate, or sweep files by hand. |
| Local configuration | Repository-root `.env`, mode `0600`, ignored by Git | Contains database and optional encryption/backup paths. It is not backed up by the application. Keep a separate protected recovery record. |
| Provider credentials | AES-256-GCM ciphertext in PostgreSQL; key only in `AI_CREDENTIAL_ENCRYPTION_KEY` | Write-only in the UI and excluded from export/backup. Losing the key requires credential replacement. |
| Browser journal cache/outbox/recording checkpoints | Owner-bound encrypted IndexedDB in each Firefox profile | Cached reads are bounded; unacknowledged source recovery data is never auto-evicted. Logout locks retained unsynced ciphertext. |
| PWA shell | Browser service-worker cache | Contains no journal content and is replaceable. |
| Backup repository/password/staging | The three configured absolute backup paths, owned by the operator account | Restic repository is encrypted. Password file is separate and required for recovery; staging is disposable only when no operation is active. |
| Downloaded exports | Operator-selected download directory | Outside application expiry and deletion control. Protect and delete them explicitly. |
| Operational logs | API/worker standard output or operator-selected sink | Content-free structured events only. Treat unexpected content as a security incident. |

Do not move a live blob root independently of its database. To inspect the
database volume name without changing it, use
`docker volume inspect ai-integrated-journal-postgres-data`.

## Forward-only migrations and upgrades

Migration SQL under `packages/database/drizzle/` is append-only. A released
migration is never edited, reordered, deleted, or given a down migration.
Applications verify compatible application and pg-boss schema state but never
migrate on startup independently; `local:start` runs the single deployment step
before starting them. `db:migrate` and `db:seed` are safe to repeat.

Upgrade one local installation in this order:

1. Stop the API and worker. Leave PostgreSQL running.
2. If backup is configured, run `corepack pnpm backup:create` and record its
   content-free snapshot ID. If it is not configured, explicitly accept that
   the upgrade has no application-verified rollback point.
3. Obtain the new release, then run
   `corepack pnpm install --frozen-lockfile`.
4. Run `corepack pnpm validate` before pointing real data at code not already
   covered by the release evidence.
5. Run `corepack pnpm local:start -- --prepare-only`. This applies outstanding
   Drizzle migrations, installs/upgrades pg-boss through the idempotent seed,
   and reconciles built-in definitions and schedules.
6. Run `corepack pnpm local:start`; sign in and check readiness, one synthetic
   or non-private representative Journal Day, audio playback, lexical search,
   and Processing Activity.

A failed migration blocks startup. Preserve its exact content-free error, keep
the API/worker stopped, and diagnose the migration or environment; do not edit
the migration ledger or run ad hoc down SQL. Application-binary downgrade after
a schema upgrade is unsupported unless that older release explicitly declares
compatibility. Recovery means fixing forward or restoring a validated
pre-upgrade backup into an empty target, never overwriting the failed live
target.

## Providers and credential rotation

The release contains provider-neutral capability ports and deterministic test
providers, but **no external provider adapter is installed**. The Settings page
therefore says that no provider adapters are available, and all source, lexical
search, export, and retention workflows remain local. Adding an adapter is a
code/deployment change: it must register capability descriptors, content
recipient, HTTPS privacy-policy URL, retention/training disclosure, supported
model configuration, and provider-specific tests before the owner can enable
it. Adding `AI_CREDENTIAL_ENCRYPTION_KEY` alone does not send content anywhere.

When a reviewed adapter is installed:

1. Generate/configure the deployment encryption key and restart the API.
2. In Settings, read and accept the exact current disclosure, choose model IDs,
   enter the write-only credential, then enable only the required capabilities.
3. Confirm Processing Activity identifies the intended provider/model and that
   a synthetic operation completes. Never use private journal text as a setup
   probe.

To rotate a provider credential, disable that provider first, create the
replacement at the provider, replace the write-only value in Settings, perform a
synthetic check, re-enable it, and only then revoke the old provider credential.
To rotate `AI_CREDENTIAL_ENCRYPTION_KEY`, disable every provider, replace the
deployment key and restart, re-enter every provider credential, validate each
with synthetic data, then retire the old key. A key rotation cannot decrypt or
re-encrypt old ciphertext automatically. Disabling or rotating a provider never
changes captured sources or historical result provenance. Content already sent
to an external provider remains subject to its disclosed policy.

## Backup, restore, export, and deletion

- [Backup and restore](backup-and-restore.md) defines encrypted repository
  initialization, daily/weekly/monthly retention, empty-target restore,
  checksums, tombstone replay, and the quarterly physical drill.
- [Portable export format](export-format.md) defines snapshot consistency,
  stable relationships, checksums, selected audio/raw bodies, and the limits of
  downloaded copies.
- [Retention and permanent deletion](retention-and-permanent-deletion.md)
  defines independent grace periods, deletion impact, tombstone-first ordering,
  browser cleanup, and anti-resurrection behavior.

Permanent deletion is initiated only through the authenticated owner UI/API
after its impact preview and exact `PERMANENTLY DELETE` confirmation. Do not
delete database rows or objects by hand: that bypasses audits, indexes, exports,
browser tombstones, and backup checkpoints. Encrypted historical bytes may
remain until backup retention expires, while newest-checkpoint replay prevents
them from becoming live application data.

## Troubleshooting

| Symptom | Safe checks | Recovery |
| --- | --- | --- |
| `local:start` rejects configuration | Run `corepack pnpm local:start -- --check`; compare key names and path policy with `configuration.md`. | Correct `.env`; never paste secret values into an issue or log. A host-run Node process uses `127.0.0.1`, while the dev container uses `host.docker.internal`. |
| Docker/Compose unavailable | Run `docker info` and `docker compose version`. | Start the approved Docker daemon. Do not bypass PostgreSQL with an untracked database. |
| Port 5432, 3000, or 5173 is busy | Identify the listening process with an OS read-only socket tool; check whether an earlier journal process is still active. | Stop the stale process. Do not change only one side of the Vite/API port contract. |
| API live but not ready | Check `/health/ready`, authenticated `/health/details`, Docker health, `BLOB_DATA_DIR` existence/permissions, and migrations. | Restore storage permissions, start PostgreSQL, then rerun `corepack pnpm local:start -- --prepare-only`. Provider absence does not cause unready state. |
| API/worker reports schema mismatch | Keep both stopped; run `corepack pnpm db:migrate` then `corepack pnpm db:seed`. | If either fails, preserve the database and fix forward or restore to an empty target. Never edit migration or pg-boss metadata manually. |
| AI stage unavailable | Check Settings provider enablement/disclosure and Processing Activity. | Source capture remains safe. Retry after provider/worker recovery; capability absence is not missing journal information. The stock release has no external adapter. |
| Upload or write returns 507 | Check real browser quota and host filesystems backing blobs/PostgreSQL. | Free unrelated data or expand storage, then retry the same stable identity. Never delete staging chunks or recovery IndexedDB records manually. |
| Search appears stale | Confirm canonical item lifecycle and worker status. Lexical removal on edit/delete is transactional. | Restart the worker for optional embeddings. After restore, do not open the app until the restore tool finishes lexical rebuild and pending-vector setup. |
| Backup command refuses to start | Confirm all three non-overlapping absolute backup paths and required external binaries. | Correct paths/install compatible restic and PostgreSQL clients. Never put the password in a command line or overlap live blobs. |
| Restore refuses the target | Confirm the target database lacks `journal`, `journal_migrations`, and `pgboss`, and the target blob directory is nonexistent/empty. | Provision a new disposable target. Refusal is a safety gate, not a reason to force overwrite. |

## Recovery drills

Record date, release hash, OS, Docker/PostgreSQL/restic/browser versions,
content-free fixture IDs, exact commands, expected/actual outcome, and issues.
Never copy private journal content into drill evidence.

1. **Cold startup and migration drill (each release).** Stop processes with
   `Ctrl+C`, run `corepack pnpm infra:down`, then
   `corepack pnpm local:start -- --prepare-only` twice. Both runs must succeed;
   the second must be idempotent. Start normally and verify live/ready plus the
   representative source/search checks.
2. **Database interruption drill (quarterly).** With synthetic work only, stop
   PostgreSQL using `corepack pnpm infra:down`. Confirm the API becomes unready
   and capture remains locally recoverable rather than acknowledged durable.
   Run `corepack pnpm local:start`; confirm the same work synchronizes once.
3. **Worker/provider outage drill (quarterly or adapter change).** Stop the
   worker or disable the reviewed provider, then add a synthetic typed source.
   Confirm source viewing/editing and lexical search remain usable and stage
   failure is not shown as user omission. Restart/re-enable and retry; confirm
   one linked attempt/result.
4. **Blob permission/capacity drill (quarterly).** Use a disposable blob root,
   never the live root. Remove write permission or inject the tested storage
   error, confirm readiness/507 and preserved checkpoints, restore permission,
   then retry the same identity. Automated error injection is the default safe
   substitute for intentionally filling a host disk.
5. **Backup/restore and permanent-deletion drill (at least quarterly and after
   schema/tool changes).** Follow the exact empty-target procedure in
   [backup-and-restore.md](backup-and-restore.md). Verify checksums, readiness,
   a representative Journal Day, audio, lexical search, pending semantic
   indexing, and continued absence of a tombstoned synthetic fixture. Destroy
   only the explicitly named disposable targets after evidence is recorded.

The full deterministic release gate is `corepack pnpm validate`. External
binary/media, physical Firefox Mobile, assistive-technology speech, browser
installation chrome, real device suspension/quota, and multi-hour soak results
must be labeled **NOT RUN** unless they were actually performed in the recorded
environment.
