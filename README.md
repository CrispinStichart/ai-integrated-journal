# AI-Integrated Journal

This repository is a pnpm workspace containing the web, API, worker, and shared
packages for the journaling application.

## Prerequisites

- Node.js 24.18.0 (see `.node-version` and `.nvmrc`)
- Corepack, included with the pinned Node.js release
- Docker with the Compose plugin (used by local PostgreSQL and persistence tests)

## Setup

```sh
corepack pnpm install --frozen-lockfile
```

Start the local PostgreSQL/pgvector service and create local blob directories:

```sh
cp .env.example .env
# Replace the password placeholder and set BLOB_DATA_DIR to an absolute path.
# When running directly on the Docker host instead of in the dev container,
# replace host.docker.internal with 127.0.0.1 in DATABASE_URL.
set -a
. ./.env
set +a
corepack pnpm infra:up
corepack pnpm data:bootstrap
corepack pnpm db:migrate
corepack pnpm db:seed
```

See `infrastructure/README.md` for storage and shutdown details.
See [docs/settings-and-privacy.md](docs/settings-and-privacy.md) for provider
credentials, retention, offline storage, backup scheduling, and session controls.

Run every local quality gate, production build, and Firefox end-to-end test:

```sh
corepack pnpm validate
```

The pre-commit hook runs the same validation command unless all staged changes
are Markdown files, all are under `.devcontainer/`, or all are under `.git/`.
Validation includes containerized PostgreSQL persistence tests, so Docker must
be running. Useful focused commands are `format:check`, `lint`, `boundaries`,
`typecheck`, `test`, `test:coverage`, `test:infrastructure`, `build`, and
`test:e2e`.

Start the three application shells in watch mode with:

```sh
corepack pnpm dev
```
