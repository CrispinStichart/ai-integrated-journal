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

Copy the local configuration, replace its database-password and blob-path
placeholders, and restrict it to your OS account:

```sh
cp .env.example .env
chmod 600 .env
```

Then start PostgreSQL, prepare storage, migrate/seed, and run the API, worker,
and web app with one command:

```sh
corepack pnpm local:start
```

Run `corepack pnpm local:start -- --check` for a content-safe configuration and
Docker preflight. See the [operations runbook](docs/operations-and-release.md),
[configuration reference](docs/configuration.md), and
[infrastructure guide](infrastructure/README.md) for data ownership, shutdown,
upgrades, providers, deletion, backup/restore, troubleshooting, and recovery
drills.

Run every local quality gate, production build, and Firefox end-to-end test:

```sh
corepack pnpm validate
```

The pre-commit hook runs the same validation command unless all staged changes
are Markdown files, all are under `.devcontainer/`, or all are under `.git/`.
Validation includes operations/documentation checks and containerized
PostgreSQL persistence tests, so Docker must be running. Useful focused commands
are `format:check`, `lint`, `boundaries`, `openapi:check`, `typecheck`,
`test:operations`, `test:coverage`, `test:infrastructure`, `build`, and
`test:e2e`.
