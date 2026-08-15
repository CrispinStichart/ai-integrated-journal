# AI-Integrated Journal

This repository is a pnpm workspace containing the web, API, worker, and shared
packages for the journaling application.

## Prerequisites

- Node.js 24.18.0 (see `.node-version` and `.nvmrc`)
- Corepack, included with the pinned Node.js release

## Setup

```sh
corepack pnpm install --frozen-lockfile
```

Run every local quality gate, production build, and Firefox end-to-end test:

```sh
corepack pnpm validate
```

The pre-commit hook runs the same validation command. Useful focused commands
are `format:check`, `lint`, `boundaries`, `typecheck`, `test`, `test:coverage`,
`build`, and `test:e2e`.

Start the three application shells in watch mode with:

```sh
corepack pnpm dev
```

