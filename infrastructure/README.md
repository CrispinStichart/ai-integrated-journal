# Local infrastructure

Copy `.env.example` to `.env`, replace its password placeholder with a
URL-safe local password, replace its example blob path with an absolute path
for your account, and export the values before starting the applications.
Compose reads `.env` automatically. The example database URL uses
`host.docker.internal` so processes in the development container can reach the
Compose port published by the Docker host. If the Node.js processes instead run
directly on that host, change the database URL host to `127.0.0.1`.

```sh
set -a
. ./.env
set +a
corepack pnpm infra:up
corepack pnpm data:bootstrap
corepack pnpm db:migrate
corepack pnpm db:seed
```

Compose runs PostgreSQL 17 with pgvector on loopback port 5432. Its data lives
in the named `ai-integrated-journal-postgres-data` volume. The initialization
script is copied into a small derived image and enables the `vector` extension
when the volume is first created. Copying it at image-build time also supports
Docker daemons that cannot see the client workspace's bind-mount paths.

`data:bootstrap` creates owner-only `final`, `staging`, and `temporary`
directories outside the source tree. It uses `BLOB_DATA_DIR` when set and
otherwise defaults to the platform user-data directory.

Migrations and seeds are deliberate commands rather than application-startup
side effects. Task 11 will register the first forward-only Drizzle migrations
and idempotent seed operations behind these stable entry points.

Run the real pgvector Testcontainers smoke test with a Docker daemon available:

```sh
corepack pnpm test:infrastructure
```

Stop services without deleting their named data volume:

```sh
corepack pnpm infra:down
```
