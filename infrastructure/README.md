# Local infrastructure

Copy `.env.example` to `.env`, replace its password placeholder with a URL-safe local password, replace its example blob path with an absolute path for your account, and set mode `0600`. The root infrastructure scripts pass `.env` explicitly to Compose, and `local:start` safely loads it for child processes. The example database URL uses `host.docker.internal` so processes in the development container can reach the Compose port published by the Docker host. If the Node.js processes instead run directly on that host, change the database URL host to `127.0.0.1`.

```sh
chmod 600 .env
corepack pnpm local:start
```

The command fails its configuration and Docker preflight before changing infrastructure, then starts Compose, bootstraps data, migrates, seeds, and runs all application shells. Use `corepack pnpm local:start -- --prepare-only` to perform only the preparation phase. See [`docs/configuration.md`](../docs/configuration.md) for every supported key.

Compose runs PostgreSQL 17 with pgvector on loopback port 5432. Its data lives in the named `ai-integrated-journal-postgres-data` volume. The initialization script is copied into a small derived image and enables the `vector` extension when the volume is first created. Copying it at image-build time also supports Docker daemons that cannot see the client workspace's bind-mount paths.

`data:bootstrap` creates owner-only `final`, `staging`, and `temporary` directories outside the source tree. It uses `BLOB_DATA_DIR` when set and otherwise defaults to the platform user-data directory.

Encrypted local backup and empty-target restore use `restic`, `pg_dump`, and `pg_restore`. Configure the optional paths in `.env`, then follow the setup, retention, recovery, and quarterly drill procedure in [`docs/backup-and-restore.md`](../docs/backup-and-restore.md). Backup repository, staging, password, and live blob paths must not overlap.

Migrations and seeds are deliberate deployment commands rather than API/worker startup side effects. `local:start` invokes the forward-only Drizzle migration and idempotent seed/pg-boss reconciliation entry points once before applications start. Released migration files are append-only; see the upgrade procedure in [`docs/operations-and-release.md`](../docs/operations-and-release.md).

Run the real pgvector Testcontainers smoke test with a Docker daemon available:

```sh
corepack pnpm test:infrastructure
```

Stop services without deleting their named data volume:

```sh
corepack pnpm infra:down
```
