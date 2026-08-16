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
# Replace the password placeholders and set BLOB_DATA_DIR to an absolute path.
set -a
. ./.env
set +a
corepack pnpm infra:up
corepack pnpm data:bootstrap
corepack pnpm db:migrate
corepack pnpm db:seed
```

See `infrastructure/README.md` for storage and shutdown details.

Run every local quality gate, production build, and Firefox end-to-end test:

```sh
corepack pnpm validate
```

The pre-commit hook runs the same validation command. It includes containerized
PostgreSQL persistence tests, so Docker must be running. Useful focused commands
are `format:check`, `lint`, `boundaries`, `typecheck`, `test`, `test:coverage`,
`test:infrastructure`, `build`, and `test:e2e`.

Start the three application shells in watch mode with:

```sh
corepack pnpm dev
```
