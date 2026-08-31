# Security and privacy review

Date: 2026-08-31
Scope: implementation through Task 52, reviewed and hardened in Task 53
Deployment reviewed: the supported private, single-owner localhost release

## Decision

The reviewed release is suitable for its documented localhost-only boundary
after the fixes in Task 53. Authentication is still required on localhost;
local binding is not treated as authentication. Journal content, audio,
transcripts, provider bodies, prompts, credentials, and session material do not
belong in operational logs or queue payloads.

This review does not authorize a LAN or hosted deployment. Such a deployment
still requires a deployment ADR and additional controls, including TLS
termination, network policy, managed secret storage, and hosted backup/blob
decisions.

## Assets, attackers, and trust boundaries

The primary assets are the owner credential and recovery material, opaque
sessions and CSRF tokens, journal/revision text, transcripts, audio and upload
chunks, processor inputs/results/raw responses, provider credentials and
disclosures, exports/backups, deletion tombstones, and content-free audit
history.

The threat actors considered were:

- an unauthenticated web or local-network client;
- a cross-site attacker acting through the owner's authenticated browser;
- a client changing opaque identifiers to read or mutate another owner;
- malicious stored journal/transcript/provider text attempting script or prompt
  injection;
- a configured external processor returning adversarial or malformed data;
- a dependency or base-image vulnerability; and
- an operator accidentally exposing content through configuration, logs,
  exports, or deletion behavior.

The trust boundaries traced were:

1. Firefox/PWA to the same-origin Vite/Express HTTP boundary;
2. Express to PostgreSQL and the local blob adapter;
3. API to pg-boss to the worker, where jobs contain identifiers/fingerprints
   rather than private source content;
4. worker to an explicitly enabled provider after disclosure acceptance;
5. API/worker to a time-limited export archive and then to a downloaded copy;
6. live database/blob state to an encrypted backup repository; and
7. the application processes to the local OS account and host filesystem.

## Abuse cases, controls, and evidence

| Area | Abuse case | Enforced control and concrete evidence |
| --- | --- | --- |
| Bootstrap | A race creates a second owner, or credential material is returned/stored in plaintext. | The singleton database constraint and transactional owner/password/recovery creation fail closed. Argon2id protects passwords; recovery codes are random, single-use hashes and appear only in the issuance response. `apps/api/test/auth.test.ts`, `apps/api/test/auth-store.test.ts`, and `apps/api/test/auth-routes.test.ts` cover the race, hashes, no-store response, and content-free `auth.owner_bootstrapped` audit. |
| Sessions | A stolen, expired, revoked, or cross-owner token remains usable. | Session and CSRF tokens are random and stored only as one-way hashes. Session cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` outside localhost; idle and absolute expiry, touch, rotation, logout, list, and owner-scoped revocation are enforced. Session APIs never return tokens. Auth tests cover expiration, rotation, revocation, cookie attributes, and owner scoping. |
| CSRF | A hostile origin causes a state change through the owner's browser. | Mutations authenticated by a session require the double-submit CSRF cookie/header; a supplied `Origin` must exactly match the configured origin. CORS is not enabled and Helmet supplies same-origin/resource policy headers. `apps/api/test/auth.test.ts`, route tests, and Firefox flows exercise the boundary. |
| Authorization | An identifier is changed to access another owner's journal, recording, result, memory, export, or settings. | Routes derive owner identity only from authentication and services/repositories include the owner in reads and mutations. Database integration suites cover owner isolation for journal, recording, transcript, processor, memory, search, retention, export, and settings operations. Not-found responses avoid confirming cross-owner existence. |
| Uploads | Active content, oversized data, corrupted chunks, or path traversal reaches storage. | Recording metadata is schema-bounded; chunk requests now require exact `application/octet-stream`, enforce declared/streamed 8 MiB limits and SHA-256, and never pass a rejected body to storage. Canonical storage keys reject non-canonical path segments; playback uses recorded `audio/*` plus `nosniff`. `apps/api/test/recording-routes.test.ts` covers active-content media-type rejection, checksums, limits, and storage pressure; storage contract tests cover traversal and owner-only permissions. |
| Stored XSS | Journal/provider text executes in the PWA or a readable export. | Vue renders content through escaped text bindings; no `v-html`/unsafe HTML sink exists. Search component tests use an `<img onerror>` fixture. Provider privacy links now require HTTPS. Readable export content is placed in a code fence longer than every attacker-supplied backtick run; fence analysis iterates without argument expansion even for many disjoint runs, while JSONL preserves exact data. `apps/web/test/search-view.test.ts`, `packages/contracts/test/settings.test.ts`, and `apps/worker/test/export.test.ts` are the regressions. |
| Processor prompts | Journal text changes system instructions or provider output becomes executable. | Fixed system instructions label source text untrusted; source is serialized as a bounded user data message. Provider output is size-bounded and schema/evidence validated before persistence; it is never treated as SQL, HTML, or a tool request. Queue payloads contain IDs/fingerprints only. Processor and grounded-answer tests use prompt-injection/script fixtures and verify no unsupported synthesis. |
| Provider privacy | Content leaves the installation without informed enablement, or a credential is disclosed. | No provider is enabled by default. Enablement requires the current disclosure-version acknowledgement; settings show recipient, external status, retention/training status, and an HTTPS privacy link before enablement. Credentials are AES-GCM encrypted, write-only, omitted from logs/API/export, and resolved only for the selected capability. Settings/AI contract, service, UI, and worker tests cover this boundary. |
| Exports | Another owner downloads an archive, expired data remains hosted, credentials leak, or stored markup becomes active. | Export creation/open is owner-scoped, snapshot-consistent, `private, no-store`, expires after 24 hours, and is audited. Snapshot tables deliberately exclude passwords, recovery codes, sessions, authenticators, challenges, provider credentials, idempotency bodies, and queue internals. Blob leases/checksums prevent mixed archives; deletion invalidates hosted copies. Export database/API/worker tests cover owner isolation, expiry, content selection, checksums, deletion races, and inert Markdown. |
| Deletion | A CSRF/IDOR deletes data, deleted data is resurrected, or a destructive action is invisible. | Soft delete, audio delete, permanent deletion request/completion, export invalidation, settings/provider changes, session logout/revocation, password recovery, passkey registration, and owner bootstrap require the appropriate authentication/CSRF boundary and append content-free audits. Auth state changes and their audits commit atomically. Permanent deletion is tombstone-first, bounded, owner-scoped, invalidates derived/search/export/cache/outbox state, and restore replays the newest deletion checkpoint before opening. Retention, export, backup, auth, and reliability suites provide behavioral evidence. |
| Logs and failures | Private content or secrets appear in logs, errors, or retry jobs. | Observability uses a deny-by-default field allowlist; HTTP completion logs record method/route/status/correlation only. Errors return stable codes without exception text, and queue retries carry canonical identifiers. Observability/API/worker reliability tests assert that bodies, headers, credentials, source text, provider payloads, and injected error messages are absent. |
| Local network | Development defaults silently publish the journal to the LAN. | Express configuration now accepts only Node-valid loopback `HTTP_HOST` values; Vite binds its API proxy to `127.0.0.1`; Compose publishes PostgreSQL on `127.0.0.1`. `packages/config/test/index.test.ts` rejects wildcard, RFC1918, unspecified or bracketed bind IPv6, and arbitrary names; `apps/web/test/vite-config.test.ts` locks the proxy boundary. |
| Supply chain | A known vulnerable dependency or image package ships. | The lockfile overrides the vulnerable transitive development `esbuild` to a fixed available release. The PostgreSQL image updates Debian security packages at build time and removes package indexes. Dependency and container scans described below are clean at their blocking thresholds. |

## Defects corrected by Task 53

1. Vite listened on `0.0.0.0`, allowing a LAN peer to reach the same-origin API
   proxy. It now listens on `127.0.0.1`, and API startup rejects non-loopback
   or invalid URL-form bind hosts while accepting raw IPv6 loopback.
2. Chunk upload accepted any request content type. It now returns a stable HTTP
   415 before streaming anything except `application/octet-stream`.
3. Stored text was emitted directly into human-readable Markdown, and provider
   privacy URLs accepted active/non-TLS schemes. Export text is now inertly
   fenced with bounded adversarial-fence analysis, and privacy links require
   HTTPS.
4. Bootstrap, password recovery, logout, and passkey administration did not all
   produce content-free audit evidence. Correlation-linked audits now cover
   those operations; bootstrap, password/code recovery rotation, session
   revocation, and passkey persistence commit atomically with their audits.
5. The locked development graph contained the moderate esbuild development
   server advisory. The transitive version is overridden to `0.25.0` and the
   dependency audit is clean.
6. The locally built PostgreSQL image contained fixed HIGH/CRITICAL Debian
   package vulnerabilities. The image now applies repository security updates
   during build; a rebuilt image has no fixed vulnerability at or above HIGH.
7. Secret scanning had no repository configuration and classified public test
   identifiers as generic keys. `.gitleaks.toml` retains the default rules and
   narrowly permits only synthetic grounded/recording/nightly fixture IDs.

## Reproducible verification

The final repository validation command is:

```sh
corepack pnpm validate
```

The security scans used were:

```sh
corepack pnpm audit --audit-level moderate
gitleaks git --config .gitleaks.toml --redact --exit-code=1 .
task53_scan_dir=$(mktemp -d)
git ls-files --cached --others --exclude-standard -z | tar --null --files-from=- --create --file=- | tar --extract --file=- --directory="$task53_scan_dir"
gitleaks dir --config .gitleaks.toml --redact --exit-code=1 "$task53_scan_dir"
docker build --pull --no-cache --tag ai-integrated-journal-postgres:pg17-pgvector0.8.1 infrastructure/postgres
grype docker:ai-integrated-journal-postgres:pg17-pgvector0.8.1 --fail-on high --only-fixed --output table
```

Results on 2026-08-31:

- full `corepack pnpm validate`: format, lint, boundaries, OpenAPI, typecheck,
  pre-commit, coverage, infrastructure, build, and Firefox E2E all passed;
- coverage: 108 files / 592 tests passed, with 82.67% statements, 75.23%
  branches, 80.26% functions, and 84.26% lines;
- infrastructure: 24 files / 83 tests passed against PostgreSQL/pgvector;
- Firefox E2E: 8/8 tests passed;
- pnpm 11.22.0: no known dependency vulnerabilities;
- Gitleaks 8.24.3: 90 commits / 11.36 MB of history and 10.63 MB of
  current tracked/untracked non-ignored repository files scanned, no leaks;
- Grype 0.116.1: no fixed vulnerabilities at or above HIGH in the rebuilt
  `ai-integrated-journal-postgres:pg17-pgvector0.8.1` image; and
- targeted security regressions: 62/62 passed before the full repository run.

These commands intentionally use `--redact`; reports and build logs must not
print candidate secret values or private journal fixtures.

## Residual risks and operating constraints

- A process or OS-account compromise can read the local database, live blobs,
  environment, and unlocked browser state. Host account isolation, patching,
  disk encryption, and physical security remain operator controls.
- Localhost prevents remote reachability but not a malicious process already
  running as the owner. Strong authentication remains mandatory.
- Once the owner enables an external provider, disclosed content is subject to
  that provider's retention/training policy. Disabling the provider cannot
  recall a copy already transmitted.
- Downloaded exports are outside application deletion/expiry control. Encrypted
  backups retain historical deleted material until repository retention expires;
  tombstone replay prevents application resurrection.
- Image package updates make a build secure against the package repositories at
  build time, but vulnerability status changes. Release builds must rebuild with
  `--pull --no-cache` and repeat the blocking scan instead of relying on this
  dated result.
- A LAN/hosted deployment, telemetry, multi-user authorization model, and
  managed cloud storage remain unsupported and require new threat models and
  ADRs.
