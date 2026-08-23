# AI-Integrated Journaling Application Implementation Plan

## 1. Purpose

This document turns the product and technical specifications into a dependency-ordered implementation plan suitable for execution by focused AI agents.

The governing documents, in precedence order, are:

1. `AI-Integrated-Journaling-Application-Specification.md` for normative product requirements.
2. `high-level-technical-overview.md` for mandatory technology decisions.
3. `technical-spec.md` for concrete implementation architecture and conventions.

If this plan conflicts with one of those documents, the governing document wins. Consequential implementation decisions must be recorded in an architecture decision record (ADR).

The central delivery principle is to stabilize invariants and contracts first, then deliver source-preserving vertical slices:

```text
Decisions and contracts
  -> durable text journal
  -> recoverable audio
  -> transcript lineage
  -> generic processor platform
  -> built-in processors and nudges
  -> search, deletion, export, and backup
  -> release hardening
```

Each numbered step below is intended to be one focused agent assignment and one tested commit unless a task is explicitly divided further during execution.

## 2. Non-negotiable implementation rules

- Sources, observations, and interpretations remain distinct.
- Original audio, raw STT, provider raw responses, immutable revisions, processor versions, and artifact versions are never overwritten.
- Human-authored and human-corrected values always outrank generated values.
- Evidence binds to exact immutable source revisions.
- Unknown, none/zero, neutral, not applicable, uncertain, and known values remain semantically distinct.
- Capture, viewing, and editing remain usable while AI processing is unavailable or failing.
- The system imposes no final recording duration or file-size limit. Capture, upload, hashing, storage, playback, export, and backup use bounded-memory streaming or chunks.
- Offline behavior is limited to adding text/audio and viewing explicitly cached entries. No offline AI processing is performed.
- Journal content, credentials, prompts, responses, and audio are excluded from logs and metrics by default.
- Tests covering normative behavior include the applicable requirement IDs in their names.
- Frontend implementation uses Vue, Vite, TypeScript, VueUse where appropriate, and daisyUI semantic components and theme tokens.
- Initial deployment is local only, but provider, storage, and deployment boundaries must remain replaceable.

## 3. Phase 0: Resolve blocking design details

### 1. Architecture decision pack - FINISHED

Create the initial ADRs and requirement-to-test matrix. Freeze:

- Stable identity and package ownership rules.
- API versioning and compatibility policy.
- Semantic-value serialization.
- Manual/generated authority and override behavior.
- Processor dependency and versioning rules.
- The boundary of the first usable release.

### 2. Queue transactionality spike - FINISHED

Prove that `pg-boss` jobs can be created inside the same PostgreSQL transaction used by Drizzle. If the selected library versions cannot share a transaction safely, adopt and document a transactional outbox rather than weakening atomicity.

Deliverables:

- Executable proof with a rollback test.
- An ADR selecting direct transactional insertion or an outbox.
- Crash and retry semantics for the chosen approach.

### 3. Audio finalization spike - FINISHED

Define and test the recovery protocol between blob finalization and PostgreSQL confirmation. These systems cannot commit atomically, so the design must cover:

- Blob succeeds and database commit fails.
- Database state is prepared but blob finalization fails.
- Retry after either failure.
- Conflicting chunks or manifests.
- Orphan discovery and safe sweeping.


### 4. Privacy, evidence, and retention decisions - FINISHED

Record decisions for:

- Whether offline cached journal entries require a local unlock.
- Cache expiry, eviction, and storage budgets.
- Logout and expired-session cache behavior.
- Evidence offset and text-normalization conventions. Prefer normalized Unicode text with zero-based, end-exclusive UTF-16 offsets because browser string APIs use UTF-16.
- Raw provider-response retention and export defaults.
- Export snapshot consistency during concurrent edits or deletion.
- Permanent-deletion tombstones and prevention of restore-based resurrection.
- Default deletion grace periods, backup retention, nudge limits, quiet hours, and enabled processors.
- Concrete local backup and encryption technology.

### 5. Recording resource policy - FINISHED

Formalize “no maximum recording length” as no application-imposed final duration or size cap. Individual chunks and HTTP requests remain bounded. The system must monitor browser quota and disk space, surface exhaustion immediately, preserve already captured chunks, and never assemble an entire logical recording in memory.

## 4. Phase 1: Engineering foundation

### 7. Monorepo and toolchain - FINISHED

Scaffold the specified pnpm workspace:

```text
apps/
  web/
  api/
  worker/
packages/
  contracts/
  domain/
  database/
  storage/
  ai/
  processors/
  observability/
  config/
  test-support/
infrastructure/
docs/adr/
playwright/
```

Pin the current Node.js active LTS and pnpm. Configure strict ESM TypeScript, package exports, dependency-boundary checks, ESLint, Prettier, Vitest, coverage, Playwright, production builds, and pre-commit hooks.

Definition of done:

- A clean checkout can install and run all root validation commands.
- All applications and packages build as empty operational shells.
- Cross-package imports use declared exports rather than source-relative paths.

### 8. Local infrastructure and typed configuration - FINISHED

Add:

- Docker Compose PostgreSQL with `pgvector` in a named volume.
- Local blob-data directory bootstrap outside the source tree.
- Typed, fail-fast environment parsing.
- A checked-in `.env.example` without secrets.
- Testcontainers support and synthetic fixtures.
- Explicit migration and seed commands.

### 9. Shared domain kernel - FINISHED

Implement and test:

- UUIDv7 identities.
- UTC instants, IANA timezones, and `YYYY-MM-DD` journal dates.
- Semantic values for unknown, known, none, neutral, uncertain, and not applicable.
- Human/generated authority.
- Append-only revision and optimistic-concurrency primitives.
- Processing lifecycle state machines.
- Soft-deletion, recovery, and audit primitives.
- Temporal value objects using Temporal semantics.

The domain package must not depend on applications, frameworks, persistence, queues, or providers.

### 10. Shared API contracts - FINISHED

Create Zod schemas for requests, responses, events, and persisted extensible values. Add:

- Cursor pagination.
- ETag and idempotency metadata.
- RFC 9457 problem details with stable error codes.
- SSE event envelopes.
- Generated OpenAPI 3.1.
- A generation-drift check.

### 11. Database foundation - FINISHED

Configure Drizzle, forward-only migrations, transaction helpers, repository conventions, and migration compatibility testing. Seed commands must create queue configuration, schedules, built-in processors, and development fixtures idempotently.

Only one active agent may own database schema changes at a time.

### 12. API operational shell - FINISHED

Build the Express application factory and add:

- Explicit dependency injection.
- Request/response validation.
- Correlation IDs.
- Deny-by-default redacted Pino logging.
- Helmet and defensive headers.
- `/health/live`, `/health/ready`, and authenticated `/health/details`.
- Authenticated SSE with reconnect/replay semantics and a polling fallback.
- Graceful shutdown.

### 13. Worker and queue foundation - FINISHED

Establish shared queue names and options, schema-version checks, the selected atomic job mechanism, worker heartbeats, retry classification, fingerprints, concurrency controls, cancellation, dead-letter behavior, scheduling, and crash recovery.

Jobs contain identifiers, not journal content. Workers reload canonical inputs from PostgreSQL and blob storage.

### 14. Frontend and PWA shell - FINISHED

Build the responsive Vue application shell with:

- Lazy Vue Router routes.
- TanStack Vue Query for server state.
- Pinia only for session-wide UI workflows.
- An IndexedDB abstraction.
- Workbox and an offline shell.
- Accessible navigation, dialogs, live regions, and status components.
- daisyUI semantic components and theme tokens.
- Component, accessibility, and PWA test harnesses.

Frontend agents must read and follow the repository daisyUI skill before implementation.

### 15. Authentication vertical slice - FINISHED

Implement:

- Race-safe first-owner provisioning.
- Argon2id password bootstrap and recovery.
- Passkeys through WebAuthn.
- Random, single-use hashed recovery codes.
- Opaque hashed sessions with idle and absolute expiry.
- Session rotation and revocation.
- Same-origin CSRF protection.
- Authentication rate limits.
- Strict cookie and CSP behavior.
- Logout and cache-clearing behavior.

## 5. Phase 2: First usable release — durable text journal

### 16. Journal domain and persistence - FINISHED

Implement journal days, contribution identities, append-only contribution revisions, past and future dates, capture and journal timezones, day reassignment, audit history, soft deletion, and restoration.

Primary requirements: ARCH-001–005, DATA-001–013, TIME-001–003, STATE-006–007.

### 17. Journal REST API - FINISHED

Add APIs for:

- Calendar summaries and complete day views.
- Typed and nudge-response creation.
- Contribution editing and revision history.
- Moving contributions between days.
- Deletion and restoration.
- Deterministic cursor pagination.

Mutations enforce idempotency keys and editable resources enforce ETags.

### 18. Journal Day and calendar UI - FINISHED

Build a mobile-first day timeline that appears coherent while retaining visible contribution boundaries and provenance. Include text creation/editing, date selection, calendar summaries, history, edit conflicts, deletion warnings, and restoration.

### 19. Offline text outbox and cached reads - FINISHED

Store text mutations in IndexedDB before network submission. Replay them in order after startup, connectivity restoration, and visibility changes. Preserve client UUIDs, deduplicate retries, surface edit conflicts, bound cached reads, and enforce the selected offline privacy policy.

### 20. Text-journal milestone - FINISHED

Run the complete source-only workflow and verify AC-001 and AC-003. This is the first usable release and must remain useful without any AI provider or worker.

## 6. Phase 3: Recoverable audio

### 21. BlobStore and local adapter - FINISHED

Implement the capability-oriented `BlobStore`, including streaming immutable writes, staging chunks, finalization, SHA-256, byte ranges, opaque-key validation, atomic local renames, owner-only permissions, and an adapter contract suite.

### 22. Recording persistence and upload API - FINISHED

Add recording, upload, and chunk persistence plus the specified protocol:

1. Idempotent recording creation.
2. Indexed chunk uploads with checksums.
3. Accepted-index query for resumption.
4. Manifest finalization.
5. Ranged playback.
6. Retry and audio-only deletion.

Enforce duplicate and checksum behavior with database constraints as well as application checks.

### 23. Browser capture controller - FINISHED

Generate recording and contribution UUIDs before capture. Use MediaRecorder timeslices, supported MIME negotiation, immediate IndexedDB persistence, quota monitoring, and a top-level controller that survives route changes.

### 24. Audio synchronization and playback UI - FINISHED

Resume missing chunks, display every local/durable/processing state, delay local cleanup until durable confirmation, expose safe retry, support range playback, and allow assignment to a different Journal Day.

### 25. Audio reliability milestone - FINISHED

Test interrupted upload, reload, suspension, duplicate retry, checksum conflict, storage exhaustion, very long recordings, crash during finalization, and staging cleanup. Cover CAP-001–007 and AC-002–003.

## 7. Phase 4: Transcript lineage

### 26. Provider-neutral AI ports - FINISHED

Implement provider factories and capability ports for:

- Speech-to-text.
- Structured generation.
- Embeddings.

Define normalized results, provider/model/configuration snapshots, capability absence, raw-response storage, and deterministic fake providers. A real provider selection is not required for the provider-neutral foundation.

### 27. Transcription pipeline - FINISHED

After durable audio confirmation, run asynchronous STT and preserve the exact raw response, normalized segments, language, effective context, configuration, timings, model identity, attempt lineage, and visible failure state.

### 28. Corrected and cleaned transcript pipeline - FINISHED

Initialize corrected text from raw STT, add append-only corrected revisions, and derive cleanup only from an exact corrected revision. Raw, corrected, and cleaned transcript layers remain distinct.

### 29. Transcript dependency and evidence model - FINISHED

Store stable segment IDs, exact revision references, defined text offsets, optional audio ranges, quote hashes, unresolved-evidence states, and targeted staleness propagation.

### 30. Transcript UI - FINISHED

Build raw/corrected/cleaned inspectors, revision history, editing, retries, processing status, audio seeking from evidence, and a clear unavailable-timing state. Verify AC-010–012.

## 8. Phase 5: Generic processor platform

### 31. Processor definition management

Implement immutable versioned definitions containing instructions, JSON Schema output contracts, input scopes and selectors, dependencies, reconciliation strategy, requirement mode, nudge policy, capability requirements, and enablement. Add validation, dry-run support, APIs, and management UI.

Processor dependency graphs must be acyclic. Bound schema complexity, prompt/input size, runtime, and result size. Journal content is untrusted prompt input, and generated output can never execute code, tools, SQL, or HTML.

### 32. Processor runtime

Assemble bounded inputs with stable labels and exact temporal context, invoke deterministic or provider processing, validate structured output, verify evidence ranges, and store complete or explicitly partial results.

### 33. Provenance graph and invalidation

Record exact artifact inputs, source revisions, processor versions, prompts, providers, models, and configurations. Traverse dependencies after a revision change, mark only downstream results stale, and enqueue replacement work.

### 34. Reconciliation engine

Implement create, update, supersede, remove/supersede, and unchanged outcomes. Add stable logical keys, serialization or locking for concurrent day reconciliation, and database-enforced idempotency.

### 35. Manual overrides and artifact editing

Add correction, split, merge, delete, confirmation, and manual override behavior. Generated results never overwrite active manual authority. Conflicts become reviewable generated candidates.

### 36. Reprocessing orchestration

Support contribution, day, date-range, processor, and version scopes with impact preview, approximate provider-operation count, progress, cancellation, audit history, and explicit processor-version basis.

### 37. Feedback and memories

Distinguish occurrence-only corrections from “correct and remember.” Implement narrow-safe scope classification, explicit approval, searchable and revisioned memory management, enable/disable/delete controls, and versioned STT context assembly. Verify AC-030–032.

## 9. Phase 6: Built-in processors and nudges

After the generic processor contracts are stable, tasks 38–42 may run in parallel in separate worktrees and modules. Each task owns its processor schema, prompt/instructions, deterministic validators, synthetic fixtures, reconciliation tests, UI result cards, and evidence inspection.

### 38. Food and drink processor

Cover consumption versus mention, ownership, qualitative quantity, whole-day reconciliation, corrections, split/merge behavior, and later clarification. Verify AC-020–021.

### 39. Mood processor

Preserve multiple contextual observations, keep the daily aggregate separate, distinguish unknown from neutral, protect manual ratings, and prohibit clinical claims. Verify AC-022–023.

### 40. Sleep and temporal processor

Implement wake-date association, separate naps and sleep periods, ambiguity, correction, original temporal phrases, and resolution provenance. Verify AC-040–041.

### 41. Tasks and intentions processor

Distinguish completed, firm, tentative, contemplative, suggested, and general-interest statements. Resolve due dates only when supported by evidence. Verify AC-024.

### 42. Summary and accomplishment processors

Keep narrative summaries separate from notable/accomplishment bullets. Support editing, adding, removal, pinning, evidence, and preservation of manual changes during reprocessing.

### 43. Requirement evaluation and nudge engine

Implement the exact states:

- `not_evaluated`
- `satisfied`
- `insufficient_information`
- `pending_user_response`
- `dismissed`
- `not_applicable`
- `failed`

Nudges are generated only after successful-enough processing, consolidated into a digest, and subject to limits and quiet hours. Support answer, defer, dismiss, and not-applicable actions with durable linked response contributions. Verify AC-042–043.

## 10. Phase 7: Retrieval and data lifecycle

### 44. Lexical search

Build revision-aware PostgreSQL full-text indexing, deterministic ranking, filters, snippets, layer selection, and immediate exclusion of stale or deleted data.

### 45. Semantic and hybrid retrieval

Add optional embeddings, compatible provider/model/dimension cohorts, reciprocal-rank fusion, and lifecycle-aware reindexing.

### 46. Grounded answers

Generate only from retrieved fragments. Validate returned citation IDs, link to precise evidence, distinguish quoted or retrieved sources from synthesis, and report insufficient support instead of inventing an answer.

### 47. Retention and permanent deletion

Implement the complete retention matrix across:

- Database rows and revisions.
- Final blobs and staging chunks.
- Browser caches and outboxes.
- Search text and vectors.
- Exports and backups.
- Provider raw responses.
- Audit records and deletion tombstones.

Verify that restores cannot resurrect permanently deleted content.

### 48. Export

Produce a point-in-time streamed ZIP containing:

- A checksummed, versioned manifest.
- JSON Lines for all relevant entities and versions.
- Human-readable Markdown by journal date.
- Selected audio and provider raw responses.
- Stable relationship identifiers.
- Semantic absence and manual-authority states.
- Complete provenance and retention metadata.

Verify AC-050–052.

### 49. Backup and restore

Back up PostgreSQL, pg-boss state, blobs, and non-secret configuration using the selected mechanism. Restore into an empty target, validate checksums and referential integrity, rebuild search indexes, and safely resume only work whose canonical state still requires it.

### 50. Settings and privacy controls

Add settings for provider disclosure and enablement, configured models, credentials, journal timezone, offline cache, retention, nudge scheduling, export, backup, privacy, and active sessions.

## 11. Phase 8: Hardening and release

### 51. Complete acceptance suite

Implement every AC-001–052 scenario and the product specification’s edge-case table as automated tests or explicitly documented manual checks.

### 52. Reliability and fault testing

Exercise:

- Provider outages and rate limits.
- Worker crashes and abandoned jobs.
- Missed SSE events and polling recovery.
- Offline reload and synchronization.
- Duplicate mutations and jobs.
- Long staleness chains.
- Concurrent whole-day reconciliation.
- Disk and browser storage pressure.
- Export during concurrent editing or deletion.
- Restore after permanent deletion.

### 53. Security and privacy review

Threat-model bootstrap, sessions, uploads, stored journal content, processor prompts, exports, deletion, and local network exposure. Verify authorization, CSRF, stored-XSS prevention, content-type handling, secret scanning, content-free logs, provider disclosure, and destructive-action audits.

### 54. Accessibility and Firefox Mobile validation

Perform keyboard, screen-reader, WCAG 2.2 AA, touch, installability, microphone, suspension, service-worker update, storage-pressure, and long-session checks. Physical Firefox Android validation is required in addition to Playwright Firefox.

### 55. Operations and release documentation

Document one-command local startup, configuration, data locations, migrations, upgrades, provider setup, backup, restore, deletion, troubleshooting, and recovery drills. Generate the final requirement-to-test traceability report.

## 12. Agent operating model

### Task packet

Every agent receives a bounded task packet containing:

- Objective and explicit non-goals.
- Applicable requirement and acceptance-criterion IDs.
- Prerequisite commits and ADRs.
- Owned files and packages.
- Shared or forbidden areas.
- Contracts the agent may change.
- Expected migrations, API behavior, worker behavior, and UI behavior.
- Named edge-case and failure fixtures.
- Exact verification commands.
- Security and privacy checklist.

### Coordination rules

- Shared contracts, migrations, processor envelopes, and domain state machines have serialized ownership.
- Prefer vertical slice agents over separate frontend-only and backend-only agents once foundations are stable.
- Parallel agents use isolated branches and worktrees. They never edit the same checkout.
- Built-in processors are the strongest parallelization opportunity.
- Read-only review agents may inspect work, but the implementation owner applies findings and owns the tested commit.
- Integration to `main` is serialized. The landing agent rebases on current `main`, resolves contract or migration ordering, runs the complete repository gates, commits, and pushes.

### Required handoff

Every implementation handoff reports:

- Commit hash.
- Migrations added or changed.
- Public contracts changed.
- Requirement IDs covered.
- Automated tests and manual checks performed.
- Security or privacy considerations.
- Known limitations and follow-up work.

## 13. Quality gates

### Every task

- Formatting and lint checks.
- Strict TypeScript typecheck.
- Relevant unit, component, integration, and property tests.
- Requirement IDs in tests for normative behavior.
- No generated OpenAPI or contract drift.
- No journal content or credentials in logs or fixtures.
- A migration for every schema change.
- Production builds for affected applications.
- Complete handoff evidence.

Before committing and pushing a completed unit, the agent must run the complete repository linting and test suite as required by `AGENTS.md`.

### Every integrated vertical slice

- Clean-database migration.
- API/database/queue integration tests.
- Crash, retry, and idempotency tests.
- Storage or provider contract tests where applicable.
- Component accessibility checks.
- Firefox Playwright critical path.
- Production builds.

### Every milestone

- Included requirements map to automated tests or documented manual verification.
- Manual-authority and deletion branches have direct coverage.
- Offline, reload, and provider-failure behavior is exercised.
- Dependency, secret, and container scans pass.
- Export/import or backup/restore smoke tests run where applicable.
- Audio and PWA milestones receive physical Firefox Mobile checks.
- Audio, export, and backup milestones pass bounded-memory and disk-pressure tests.

Coverage floors are:

- Domain, contracts, storage, and processor packages: 90% statements, lines, and functions; 85% branches.
- Other packages and applications: 80% statements, lines, and functions; 75% branches.
- Authentication, manual-authority protection, upload idempotency, deletion exclusion, and unknown-versus-zero behavior require direct branch coverage regardless of aggregate coverage.

## 14. Recommended release checkpoints

1. **Source-only journal:** secure typed capture, revisions, offline outbox, cached reads, calendar, deletion, and recovery.
2. **Audio journal:** recoverable recording, resumable upload, immutable local storage, and ranged playback.
3. **Transcript journal:** asynchronous STT, transcript lineage, correction, cleanup, timing, and retry.
4. **AI journal:** generic processor framework, provenance, manual overrides, feedback, and built-in processors.
5. **Complete local release:** nudges, search, grounded answers, retention, export, backup/restore, and all hardening gates.

No checkpoint may make generated data the sole durable record of user content.
