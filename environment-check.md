# Environment Tooling Verification

This runbook verifies that an environment can build, test, and run the
AI-integrated journaling application described by `technical-spec.md`. Run it
before beginning application work and after moving the repository to a new
machine or execution environment.

The procedure is intentionally fail-fast. If a check fails because of the host,
permissions, network, credentials, or an external service, stop after safely
cleaning up resources created by the current check. Do not install, reconfigure,
or repair host software. Report the blocker to the user. Repository-local fixes
are allowed only when the user has separately authorized implementation work.

Do not record machine-specific results, credentials, tokens, or environment
values in this file. Report results in the agent response instead.

## 1. Rules and pass criteria

- Read `AGENTS.md`, `high-level-technical-overview.md`, and `technical-spec.md`
  before running checks.
- Run commands from the repository root unless a step explicitly says to use
  the disposable smoke-test directory.
- Do not create package manifests, lockfiles, caches, test output, or other
  smoke-test artifacts in the repository.
- Do not modify the active Node version, enable Corepack globally, install host
  packages, change Docker settings, alter Git credentials, or start persistent
  services as part of this procedure.
- Use repository version pins when they exist. Check, in order,
  `package.json#engines`, `package.json#packageManager`, `.nvmrc`, and
  `.node-version`. Until the foundation scaffold supplies those pins, require
  Node 24.x and pnpm 11.21.0.
- A tool returning a version is not sufficient by itself. The full run must
  prove package installation and execution, Linux container execution,
  PostgreSQL with pgvector, Testcontainers, and headless Firefox.
- After a failed smoke test, perform only narrowly scoped cleanup for resources
  created by that test, then stop.
- GitHub CLI (`gh`) is optional. Its absence is not a failure because this
  repository uses ordinary Git and no current workflow requires `gh`.

A successful run has no failed or skipped required checks. Checks explicitly
listed as deferred are not required until their corresponding architecture or
provider decision is made.

## 2. Result format

Report each check using this table shape in the agent response; do not edit the
table into this file.

| Check | Status | Version or evidence | Notes |
| --- | --- | --- | --- |
| Example: Docker engine | PASS | `29.6.2`, Linux | Daemon reachable |

Use only `PASS`, `FAIL`, `NOT RUN`, or `DEFERRED`. On failure, include:

1. the exact check and command that failed;
2. concise error output and exit code;
3. whether the problem is repository-local or environmental;
4. every later check that was not run because of fail-fast behavior; and
5. confirmation that disposable resources were cleaned up.

Never include secrets or complete environment dumps in the report.

## 3. Non-invasive preflight

Run all commands in this section before creating disposable resources. These
commands must not change repository files or remote state.

### 3.1 Repository state and tool resolution

PowerShell:

```powershell
git status --short --branch
Get-Command git,node,npm,corepack,docker -All |
  Select-Object Name,CommandType,Source,Path,Version
git --version
node --version
npm --version
corepack --version
docker version
docker compose version
docker context show
docker info --format '{{json .ServerVersion}} {{json .OSType}} {{json .Architecture}}'
```

POSIX shell:

```sh
git status --short --branch
command -v git node npm corepack docker
git --version
node --version
npm --version
corepack --version
docker version
docker compose version
docker context show
docker info --format '{{json .ServerVersion}} {{json .OSType}} {{json .Architecture}}'
```

Pass criteria:

- The worktree has no unexpected changes. Existing user changes must be
  preserved and reported, not modified.
- Git, Node, npm, Corepack, Docker, and Docker Compose resolve successfully.
- Node matches the repository pin. Without a pin, its major version is 24.
- Docker has a reachable Linux daemon. Windows-container mode does not satisfy
  the PostgreSQL/Testcontainers requirements.
- Command resolution does not point to missing or stale shims.

Do not invoke Corepack from the repository until `package.json` contains a
`packageManager` field. Some Corepack versions offer to modify an unpinned
project. The pinned pnpm executable is tested later from a disposable project.

### 3.2 Disk and filesystem access

Require at least 10 GiB free on the volume used for temporary files, package
caches, Playwright browsers, and Docker data. Docker Desktop may store its data
on a different volume; inspect Docker Desktop's configured disk limit if the
daemon reports a space error.

PowerShell:

```powershell
$tempPath = [System.IO.Path]::GetTempPath()
$tempRoot = [System.IO.Path]::GetPathRoot($tempPath)
Get-PSDrive -Name $tempRoot.TrimEnd(':\') |
  Select-Object Name,Root,Free,Used
docker system df
```

POSIX shell:

```sh
df -Pk "${TMPDIR:-/tmp}"
docker system df
```

The later temporary-project creation and deletion are the definitive
filesystem permission test. Do not change directory ACLs or ownership to make
the check pass.

### 3.3 Git remote access

```sh
git remote -v
git ls-remote --exit-code origin HEAD
git push --dry-run origin main
```

Pass criteria:

- `origin` is the intended repository.
- Reading `HEAD` succeeds.
- The dry-run authenticates and reports what would be pushed without changing
  the remote.

Do not run a real push merely to test access. The final repository commit and
push, when otherwise authorized and all quality gates pass, provide the real
write-path verification.

## 4. Create a disposable smoke-test directory

Only create this directory after every preflight check passes.

PowerShell:

```powershell
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
  'ai-journal-envcheck-' + [guid]::NewGuid().ToString('N')
)
New-Item -ItemType Directory -Path $smokeRoot | Out-Null
Set-Location -LiteralPath $smokeRoot
```

POSIX shell:

```sh
smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/ai-journal-envcheck.XXXXXX")"
cd "$smoke_root"
```

Create a minimal `package.json` in that directory with the following content:

```json
{
  "name": "ai-journal-environment-check",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.21.0"
}
```

Run `corepack pnpm --version`. It must report exactly `11.21.0`. Downloading and
caching the pinned package manager is part of this test, but do not activate it
globally.

## 5. JavaScript package and quality-tool smoke test

From the disposable directory, prove registry access and package installation:

```sh
npm view lodash-es version
corepack pnpm view lodash-es version
corepack pnpm add lodash-es argon2 pg
corepack pnpm add --save-dev typescript @types/node @types/pg \
  eslint @eslint/js prettier vitest \
  @testcontainers/postgresql playwright
```

On PowerShell, put the command on one line or replace each POSIX `\` line
continuation with PowerShell's backtick continuation.

Pass criteria:

- Both registries return package metadata.
- pnpm creates a lockfile and installs all dependencies in the disposable
  directory.
- There are no certificate, proxy, DNS, permissions, lifecycle-script, or
  native-binary errors.
- `corepack pnpm audit` completes. Report advisories; treat an advisory as a
  repository dependency-selection issue when it has a supported upgrade, and
  as an external blocker only when registry access itself fails.

Create minimal source and configuration files in the disposable directory that
exercise the installed tools:

- A TypeScript module imports `chunk` from `lodash-es` and exports a typed
  function.
- A Vitest test imports that function and asserts its result.
- A Node script imports `argon2`, hashes a synthetic string, and verifies it.
- `tsconfig.json` enables strict ESM compilation.
- `eslint.config.js` uses the installed flat-config API and checks the source
  and tests.
- The files are formatted with Prettier once, then checked without rewriting.

Run:

```sh
corepack pnpm exec tsc --noEmit
corepack pnpm exec eslint .
corepack pnpm exec prettier --check .
corepack pnpm exec vitest run
node ./argon2-smoke.mjs
```

Every command must exit zero, and the Argon2 script must explicitly confirm
that verification returned `true`. A missing native binary or loader failure is
an environmental blocker; do not install compilers or SDKs to repair it.

## 6. Docker and Docker Compose smoke tests

### 6.1 Basic Linux container

```sh
docker pull hello-world:latest
docker run --rm hello-world:latest
```

The image pull and container must succeed. Record the resolved image digest.

### 6.2 PostgreSQL with pgvector

In the disposable directory, create `compose.yaml` containing a single service
named `postgres`:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_DB: journal_envcheck
      POSTGRES_USER: journal_envcheck
      POSTGRES_PASSWORD: envcheck-only
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U journal_envcheck -d journal_envcheck"]
      interval: 2s
      timeout: 2s
      retries: 30
    ports:
      - "127.0.0.1::5432"
```

Validate and start it under a unique Compose project:

```sh
docker compose -p ai-journal-envcheck config --quiet
docker compose -p ai-journal-envcheck up -d --wait
docker compose -p ai-journal-envcheck ps
docker compose -p ai-journal-envcheck exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U journal_envcheck -d journal_envcheck \
  -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion FROM pg_extension WHERE extname = 'vector'; SELECT '[1,2,3]'::vector <-> '[3,2,1]'::vector AS distance;"
```

Pass criteria:

- Compose validation succeeds and the container becomes healthy.
- PostgreSQL accepts a connection.
- `CREATE EXTENSION vector` succeeds, returns a version, and evaluates the
  vector-distance expression.

Always clean up this step, even after failure:

```sh
docker compose -p ai-journal-envcheck down --volumes --remove-orphans
```

After cleanup, `docker compose -p ai-journal-envcheck ps --all` must show no
remaining resources. Do not prune unrelated Docker objects.

## 7. Testcontainers smoke test

In the disposable Vitest project, add a test that:

1. imports `PostgreSqlContainer` from `@testcontainers/postgresql`;
2. starts `pgvector/pgvector:pg17` with a unique database, username, and
   synthetic password;
3. connects using `pg` and the container's returned connection URI;
4. creates the `vector` extension and evaluates a vector-distance query;
5. closes the client and stops the container in `finally` blocks.

Run only that test:

```sh
corepack pnpm exec vitest run testcontainers-smoke.test.ts
```

Pass criteria are successful Docker discovery, image/container startup, mapped
port connectivity, SQL execution, and automatic container cleanup. If the test
fails, inspect only its container/log output and then stop; do not alter the
Docker socket or daemon permissions.

## 8. Playwright Firefox smoke test

From the disposable project, download the Playwright-managed Firefox build:

```sh
corepack pnpm exec playwright install firefox
```

Add a script that imports `firefox` from `playwright`, launches it headlessly,
opens a page containing synthetic HTML, verifies `navigator.userAgent` and a
DOM value, then closes the browser in a `finally` block. Run it with Node.

Pass criteria:

- The browser download succeeds and its checksum is accepted.
- Headless Firefox starts, renders and evaluates the synthetic page, and exits
  cleanly.

If Linux shared libraries or browser sandbox support are missing, report an
environmental blocker. Do not run `playwright install-deps`, `apt`, `sudo`, or
another host-modifying repair command.

This check covers automated Firefox compatibility. Real Firefox Mobile device
testing remains a later manual quality gate and is not emulated by desktop
Playwright.

## 9. Disposable Git write test

Still outside the application repository, create a nested disposable Git
repository, set a synthetic identity locally, create one synthetic file, stage
it, and commit it:

```sh
mkdir git-smoke
cd git-smoke
git init
git config user.name "Environment Check"
git config user.email "environment-check.invalid@example.invalid"
git add README.md
git commit -m "environment smoke test"
git status --short
cd ..
```

Pass criteria are a successful commit and an empty nested worktree. Do not add a
remote or push the disposable repository. Origin authentication was already
tested safely with `git push --dry-run` in the real repository.

## 10. Cleanup

First ensure that the Compose and Testcontainers resources created by this run
are stopped. Then leave the disposable directory and delete only its resolved,
uniquely prefixed path.

PowerShell:

```powershell
Set-Location -LiteralPath $env:TEMP
$resolvedSmokeRoot = (Resolve-Path -LiteralPath $smokeRoot).Path
$resolvedTempRoot = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path
if (-not $resolvedSmokeRoot.StartsWith($resolvedTempRoot) -or
    (Split-Path -Leaf $resolvedSmokeRoot) -notlike 'ai-journal-envcheck-*') {
  throw "Refusing to remove unexpected path: $resolvedSmokeRoot"
}
Remove-Item -Recurse -Force -LiteralPath $resolvedSmokeRoot
```

POSIX shell:

```sh
cd "${TMPDIR:-/tmp}"
case "$smoke_root" in
  "${TMPDIR:-/tmp}"/ai-journal-envcheck.*) rm -rf -- "$smoke_root" ;;
  *) echo "Refusing to remove unexpected path: $smoke_root" >&2; exit 1 ;;
esac
```

Verify that the disposable path no longer exists and that `git status --short`
in the application repository contains no smoke-test artifacts.

## 11. Repository-driven checks after foundation scaffolding

Once the repository contains its actual manifests and scripts, rerun the
preflight and disposable checks, then also run every root quality gate defined
by `package.json` and CI. At minimum this must cover formatting, linting,
TypeScript type checking/builds, unit/component tests, database and queue
integration tests, Firefox Playwright tests, production builds, migration and
export/import smoke tests, dependency audit, secret scanning, and container
scanning.

Use the exact scanner and hook implementations selected in repository config;
the current documentation-only repository has not selected concrete secret or
container scanner products. Do not silently substitute a different product.
Verify pre-commit hooks only after their repository-managed implementation
exists. A missing future repository script or config is a repository-local
failure, not a reason to install global tooling.

## 12. Deferred checks

The following checks remain `DEFERRED` until their design decisions and
credentials exist:

- paid or external AI speech, generation, and embedding providers;
- Azure Blob Storage and managed identity;
- hosted runtime, managed PostgreSQL, TLS termination, and secret management;
- hosted backup destination and disaster-recovery infrastructure;
- notification delivery outside the in-app PWA; and
- physical Firefox Mobile devices.

Never use real journal content, production credentials, paid provider calls, or
remote infrastructure merely for an environment smoke test.
