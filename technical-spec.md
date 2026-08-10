# AI-Integrated Journaling Application — Technical Specification

**Status:** Initial implementation specification

**Version:** 1.0

**Date:** 2026-08-09

**Normative sources:** `AI-Integrated-Journaling-Application-Specification.md` and `high-level-technical-overview.md`

## 1. Purpose and precedence

This document defines how the product requirements will be implemented. It turns the conceptual source → observation → interpretation model into concrete applications, packages, data structures, APIs, processing workflows, and verification practices.

The two normative source documents remain authoritative. If this document conflicts with a product requirement, the product requirement wins. If it conflicts with a mandatory technology decision in the high-level technical overview, the overview wins. Unspecified implementation details use the conventional choices recorded here and may later change through an architecture decision record (ADR).

The first supported deployment is a private, single-user installation on localhost. The design keeps deployment, AI-provider, and blob-storage boundaries explicit so that later hosting does not require changing the canonical data model.

## 2. Architectural decisions

| Area | Decision | Reason |
| --- | --- | --- |
| Repository | pnpm workspaces | Keeps the small, single-developer monorepo simple while supporting shared packages and filtered/recursive scripts without a separate task runner. |
| Runtime | Current Node.js active LTS, pinned per repository | Common runtime for the API, worker, tooling, and shared TypeScript. |
| Frontend | Vue 3, TypeScript, Vite, Vue Router, Pinia, TanStack Vue Query, VueUse | Required Vue/Vite stack; explicit separation of route, local, and server state. |
| UI | Tailwind CSS with daisyUI | Required component system; semantic daisyUI theme tokens support accessible themes. |
| PWA | `vite-plugin-pwa`/Workbox plus IndexedDB | Standard service-worker tooling and durable browser-side capture. |
| Backend | Express.js REST API and a separate TypeScript worker process | Required backend framework with failure isolation for long-running AI work. |
| Validation/contracts | Zod schemas shared by web, API, and worker; generated OpenAPI 3.1 | One runtime-valid contract rather than duplicated TypeScript-only types. |
| Metadata store | PostgreSQL with Drizzle ORM and SQL migrations | Transactions, JSONB, full-text search, provenance relationships, and vector support fit the domain. |
| Semantic index | `pgvector`, enabled only when an embedding provider is configured | Keeps semantic and relational deletion semantics in one durable store. |
| Job queue | `pg-boss` on PostgreSQL | Durable asynchronous stages, retries, concurrency limits, and scheduled work without a second infrastructure service. Jobs can be created atomically with application changes. |
| Blob storage | `BlobStore` interface; local filesystem implementation initially, Azure Blob implementation later | Meets the required storage portability while retaining immutable object semantics. |
| API style | Versioned REST JSON, streaming binary routes, and server-sent events (SSE) | Simple browser integration; SSE is sufficient for one-way processing updates. |
| IDs | UUIDv7 generated before persistence where practical | Stable, globally unique, time-sortable identities that work offline. |
| Time | UTC instants, IANA timezone names, and separate ISO calendar dates | Preserves capture time, timezone, and journal-day semantics without implicit reassignment. |
| Tests | Vitest, Vue Test Utils, Supertest, Testcontainers, and Playwright | Covers shared/domain logic, Vue components, HTTP integration, real infrastructure, and end-to-end behavior. |

Dependencies will be pinned by the pnpm lockfile and updated deliberately. Application code uses ECMAScript modules, strict TypeScript, and browser/runtime APIs available in the repository-pinned targets.

## 3. System context and process topology

```text
Firefox Mobile / desktop browser
  ├─ Vue PWA and service worker
  ├─ IndexedDB capture/outbox/cache
  └─ HTTPS-on-hosted / localhost HTTP
              │ REST, streamed chunks, SSE
              ▼
        Express API process
          ├─ PostgreSQL ── metadata, revisions, provenance, search,
          │                 and pg-boss jobs
          ├─ BlobStore ─── local files initially; Azure Blob later
          └─ pg-boss client
                         │
                         ▼
                   Worker process
                    ├─ STT adapter
                    ├─ generation/structured-output adapter
                    ├─ embedding adapter
                    └─ cleanup, extraction, reconciliation, export,
                       retention, and indexing jobs
```

The API and worker are separate processes but use the same domain and persistence packages. The API never waits synchronously for transcription or processor completion. Browser capture continues to save locally when the API is unavailable, and durable sources remain usable when workers or an AI provider are unavailable (ARCH-005, STATE-002, STATE-006, STATE-007).

PostgreSQL is the authority for journal state, processing lifecycle, and queued work. The API inserts a `pg-boss` job within the same PostgreSQL transaction as the state change that requires it, using the official Drizzle integration. A commit makes both visible; a rollback creates neither. `pg-boss` is used directly as the concrete queue implementation—there is no application-level queue abstraction. Queue names and job option constants are shared to prevent producer/consumer drift.

## 4. Monorepo layout

```text
/
├─ apps/
│  ├─ web/                 Vue/Vite PWA
│  ├─ api/                 Express HTTP/SSE application
│  └─ worker/              pg-boss consumers and scheduled jobs
├─ packages/
│  ├─ contracts/           Zod API schemas, DTOs, enums, OpenAPI generation
│  ├─ domain/              entities, value objects, policies, state machines
│  ├─ database/            Drizzle schema, migrations, repositories
│  ├─ storage/             BlobStore interface and local/Azure adapters
│  ├─ ai/                  provider interfaces, prompt assembly, adapters
│  ├─ processors/          processor runtime and built-in definitions
│  ├─ observability/       logging, metrics, tracing, redaction
│  ├─ config/              environment parsing and typed configuration
│  └─ test-support/        factories, fixtures, fake providers, containers
├─ infrastructure/
│  ├─ compose.yaml         local PostgreSQL with pgvector
│  └─ local/               local data-directory bootstrap and backup scripts
├─ docs/
│  └─ adr/                 consequential decision records
├─ playwright/             end-to-end tests and fixtures
└─ package.json
```

Package imports flow inward: apps may import packages; `domain` imports no app, database, provider, or framework code; adapters implement ports declared by domain-facing packages. Cross-package imports use declared package exports, never another package's source-relative path.

Shared packages contain behavior or contracts genuinely used by more than one process. Browser-only and server-only modules have explicit export conditions so credentials and Node dependencies cannot enter the web bundle.

## 5. Engineering conventions

- TypeScript uses `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `useUnknownInCatchVariables`.
- Root package scripts use pnpm workspace filtering and recursive execution to run development, build, typecheck, lint, and test tasks across applications and packages. Independent watch-mode tasks run in parallel; dependency-sensitive build tasks follow workspace dependency order.
- CI caches the pnpm package store but does not add build-output/task caching initially. A dedicated monorepo task runner may be reconsidered only if measured build or test times justify it.
- ESLint, Prettier, and dependency-boundary rules run from the repository root. No `any` is allowed without a localized explanation.
- `lodash-es` is used for well-tested collection/object operations when it improves clarity; native primitives remain appropriate for trivial operations. Server builds preserve ESM tree-shaking.
- Vue code uses Composition API and `<script setup>`. VueUse is the first choice for browser events, connectivity, media queries, storage, focus, visibility, and lifecycle helpers.
- Server code uses dependency injection through explicit constructors/factories, not a global service locator.
- All mutations are transactionally validated in domain services. HTTP handlers translate requests and responses but do not contain domain policy.
- All dates crossing an API boundary are ISO 8601 strings. Instants include `Z` or an offset; journal dates are `YYYY-MM-DD`; timezones are IANA names.
- Errors returned by the API use RFC 9457 problem details with a stable application error code and correlation ID. Stack traces and private content are never returned.
- Database changes use forward-only, reviewed migrations. A migration compatibility test upgrades a production-shaped fixture from the previous release.

## 6. Domain and persistence model

### 6.1 General persistence rules

PostgreSQL tables use UUID primary keys, `created_at`, and `updated_at` where mutation is permitted. Immutable tables omit update paths. User-editable content is append-versioned: the stable entity points to its current revision, while prior revisions remain available for audit. Optimistic concurrency uses an integer revision number or strong ETag.

The application stores semantic absence explicitly. Optional JSON fields are omitted when unknown; fields whose domain requires an explicit state use a tagged value such as `{ state: "unknown" }`, `{ state: "known", value: ... }`, `{ state: "none" }`, `{ state: "neutral" }`, `{ state: "not_applicable" }`, or `{ state: "uncertain", value?: ..., confidence?: ... }` (SEM-001–SEM-005). A database `NULL` means “not represented/not applicable to this row,” not zero or neutral.

Rows use `deleted_at` for the recoverable deletion window. Normal queries, search, processing, and retrieval always exclude deleted rows. Hard deletion is performed by the retention worker after the configured grace period.

### 6.2 Identity and journal tables

| Table | Key fields and constraints |
| --- | --- |
| `users` | Single bootstrap user initially; locale, journal timezone, preferences version. |
| `authenticators` | Passkey credentials and counters; credential public data only. |
| `password_credentials` | Optional recovery/login password hashed with Argon2id; never reversible. |
| `sessions` | Opaque hashed session token, user, expiry, last-used time, revocation time. |
| `journal_days` | User, local `journal_date`; unique `(user_id, journal_date)`; stable independently of contributions. |
| `contributions` | Journal day, type (`typed_text`, `recording`, `nudge_response`), author, capture instant, effective timezone, lifecycle, optional eliciting nudge, deletion state. |
| `contribution_revisions` | Contribution, monotonically increasing revision, content, author/authority, content hash, edit reason, created time. Unique `(contribution_id, revision)`. |

A future date creates a normal `journal_days` row. Moving a contribution to a different day updates its journal-day relationship through an audited command; capture instant and original timezone never change (DATA-001–DATA-013, TIME-001–TIME-003).

### 6.3 Recording and source lineage

| Table | Key fields and constraints |
| --- | --- |
| `recordings` | Contribution, client-generated recording ID, capture MIME/codec, duration if known, final byte size, SHA-256, blob key, persistence state. Final blob fields become immutable after confirmation. |
| `recording_uploads` | Recording, upload state, expected/received chunk indexes, last activity, finalize token. |
| `recording_chunks` | Upload, zero-based index, byte size, SHA-256, staging blob key; unique `(upload_id, index)`. |
| `transcription_runs` | Recording, provider/model/config references, context snapshot/version, status, attempt, timings, raw response blob/reference, error code. |
| `transcripts` | Recording and layer (`raw_stt`, `corrected`, `cleaned`), current revision, source run or source transcript revision. Only one current logical transcript per layer. |
| `transcript_revisions` | Transcript, revision, text, structured segments/tokens, language, author/authority, input fingerprint, created time. Raw-STT revisions are immutable provider captures. |

Raw provider responses and original audio are immutable blobs. Corrected and cleaned transcripts are separate logical artifacts. Initial corrected text is copied from the selected raw STT result; cleanup always uses a specific corrected revision. A new STT attempt creates a new run and raw artifact rather than replacing prior output (DATA-020–DATA-028).

Transcript segments use stable segment IDs and character offsets within their immutable revision. Where supplied, they also store audio start/end milliseconds and provider token metadata. Evidence always identifies a source revision, so edits cannot silently retarget old character offsets. UI diff mapping may propose equivalent spans across revisions; unresolved evidence is marked as such and dependent results become stale (PROV-001–PROV-004).

### 6.4 Processors, derived artifacts, and provenance

| Table | Key fields and constraints |
| --- | --- |
| `processors` | Stable identity, name, kind, enabled state, current version, owner, requirement mode. |
| `processor_versions` | Immutable instructions, input-scope declaration, JSON Schema output contract, reconciliation strategy, nudge configuration, prompt template hash. |
| `processing_runs` | Processor/version or built-in stage, target scope, status, idempotency fingerprint, provider/model/config snapshot, attempt lineage, start/end/error. |
| `derived_artifacts` | Stable logical artifact, kind (`observation`, `interpretation`, `source_transform`), processor, target day/scope, current version, authority, manual-modification state. |
| `artifact_versions` | Immutable payload JSONB, lifecycle, confidence/uncertainty, completeness, input fingerprint, created by run/user, supersession metadata. |
| `artifact_inputs` | Artifact version to exact contribution/source/artifact revisions used as direct inputs. |
| `evidence_spans` | Artifact version, exact source revision, character range, optional audio range, quote hash, resolution status. |
| `manual_overrides` | Target artifact/path, authoritative user value, reason, revision, active state. |

The common artifact envelope lives in relational columns; processor-specific data lives in validated JSONB. Every stored payload validates against the immutable JSON Schema on its `processor_versions` row. New processor versions may add schemas without rewriting historical payloads (DATA-030–DATA-033, PROC-006–PROC-008).

Generated output is a proposal. The domain reconciler compares it with existing logical artifacts and applies `create`, `update`, `supersede`, `remove/supersede`, or `unchanged`. It never overwrites an active manual override. A conflict creates a reviewable generated candidate linked to the authoritative manual value (ARCH-004, EDIT-005–EDIT-008).

Built-in payload contracts include:

- Food/drink consumption event: logical event key, description, meal/time context, explicit temporal value, qualitative quantity text, normalized quantity only when supported, classification flags, and ownership/consumption evidence.
- Mood observation: characterization/valence as stated or cautiously normalized, period/context, uncertainty, and evidence. Daily mood aggregate is a separate interpretation.
- Sleep event: nightly/nap/other period, wake-date association, reported quality, supported time/duration fields, interruptions, and evidence.
- Task/thing-to-remember: category, intention strength, status, description, supported due date, original temporal phrase, resolution basis, and evidence.
- Daily summary: narrative interpretation plus independently versioned notable/accomplishment bullets. Pins and user edits are manual overrides.

### 6.5 Memory, feedback, nudges, and audit

| Table | Key fields and constraints |
| --- | --- |
| `memories` / `memory_revisions` | Type, scoped content, rationale/source, creator, approval state, enabled state, immutable history. |
| `feedback` | Target artifact/revision, original feedback, classified scope, resulting action/memory, actor, time. |
| `requirement_evaluations` | Day, processor version, one of the required semantic states, supporting run, revision. |
| `nudges` / `nudge_items` | Consolidated digest, schedule, status, day, linked evaluations, response contribution. |
| `audit_events` | Actor, action, target identifiers, before/after hashes or non-sensitive metadata, correlation ID, time. |

Occurrence-only corrections update only the selected revision. Creating a global memory/rule is a distinct, explicit command and approval flow. Suggested memories remain inactive until approved. Memory content and changes are visible through the settings UI (MEM-001–MEM-007, FB-001–FB-004).

Requirement evaluations use exactly: `not_evaluated`, `satisfied`, `insufficient_information`, `pending_user_response`, `dismissed`, `not_applicable`, or `failed`. Only a successful-enough processor run may move an evaluation to `insufficient_information`; technical failure moves it to `failed`. The scheduler consolidates eligible items into one digest and respects per-day dismissal, deferral, frequency, quiet hours, and daily limits (NUDGE-001–NUDGE-007).

## 7. Blob storage

### 7.1 Port

`BlobStore` exposes capability-oriented methods rather than provider SDK types:

```ts
interface BlobStore {
  putImmutable(input: AsyncIterable<Uint8Array>, metadata: BlobMetadata): Promise<StoredBlob>;
  putStagingChunk(uploadId: string, index: number, input: AsyncIterable<Uint8Array>, checksum: string): Promise<StagedChunk>;
  finalizeChunks(uploadId: string, orderedChunks: readonly StagedChunk[], metadata: BlobMetadata): Promise<StoredBlob>;
  open(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>;
  stat(key: string): Promise<StoredBlobMetadata>;
  delete(key: string): Promise<void>;
}
```

All writes stream and calculate SHA-256 incrementally. Callers never depend on local paths, Azure ETags, or container names. Storage contract tests run unchanged against each adapter.

### 7.2 Local filesystem adapter

The local root is configured outside the source tree. Final objects use content-addressed or UUID-sharded keys such as `audio/01/9f/<recording-id>/original.webm`; staging uses a separate directory. The adapter writes to a temporary file, flushes it, and atomically renames it into place. It refuses to replace an existing immutable key with different bytes. Directory traversal is prevented by treating keys as validated opaque identifiers.

Only the application OS user may access the local data directory. Production migration to Azure maps immutable objects to private containers, uses managed identity, disables public access, and preserves the same logical keys and checksums.

### 7.3 Retention and deletion

Original audio is retained indefinitely by default. Audio can be soft-deleted independently from transcripts. During the configurable grace period (default 30 days), it is hidden and unavailable to processors but recoverable. Permanent deletion removes the blob, invalidates playback evidence, marks dependent search/index records unavailable or stale, and appends an audit event. Backups expire deleted data according to the documented backup retention window (RET-001–RET-007).

## 8. Capture, offline behavior, and upload protocol

### 8.1 Recording lifecycle

The browser creates the recording and contribution UUIDs before capture begins. It selects the first supported MIME type from an ordered compatibility list (Opus in WebM, Opus in Ogg, then browser default) and records with `MediaRecorder` timeslices. Each emitted chunk is immediately stored in IndexedDB with its index, checksum, MIME type, capture timestamps, journal-date assignment, and state. The UI displays `recording`, `saved locally`, `uploading`, `durably saved`, `transcription pending`, and failure states (CAP-002–CAP-006).

IndexedDB, not component memory, is the recovery authority until server finalization succeeds. The PWA registers background sync when available but also resumes the outbox on app startup, connectivity restoration, and visibility changes because Firefox support for background sync is not assumed. The user may leave or close the app once the UI confirms the latest chunk is saved locally.

There is no application-level maximum recording length or final byte size. Fixed-size/time chunks bound memory and request size. Storage availability is monitored, browser quota errors are surfaced immediately, and long capture never requires building the full recording in RAM (CAP-005).

### 8.2 Resumable upload

1. `POST /api/v1/recordings` idempotently creates or returns the server record for the client UUID.
2. `PUT /api/v1/recordings/{id}/chunks/{index}` streams one chunk with its checksum and idempotency key. Re-uploading identical bytes succeeds; conflicting bytes returns `409`.
3. `GET /api/v1/recordings/{id}/upload` returns accepted indexes so a client can resume.
4. `POST /api/v1/recordings/{id}/finalize` submits the ordered manifest. The server validates every chunk, streams assembly/final hashing through `BlobStore`, and atomically marks the original durable.
5. Only after durable confirmation does the client mark local chunks eligible for cache cleanup and the API enqueue transcription.

Express routes stream bodies directly and apply a per-chunk limit only; JSON body limits do not constrain the logical recording size. Finalization is idempotent. Abandoned staging chunks are retained for a recovery interval and then swept only when no active upload references them (CAP-003, CAP-004, AC-002).

### 8.3 Typed text and offline outbox

Typed contributions are stored in IndexedDB before network submission. Each outbox mutation contains a UUID, idempotency key, base revision/ETag, journal date, capture instant, and timezone. The sync engine sends mutations in order and retains them until acknowledged. An edit conflict never silently wins: the server returns `409` with the current revision and the UI offers a merge/retry flow.

Offline mode supports only capture and viewing previously cached entries. No STT, cleanup, extraction, synthesis, semantic search, or nudge evaluation runs in the browser. Cached server data is user-scoped, bounded by an explicit cache policy, cleared on logout, and never treated as an independent canonical database.

### 8.4 PWA caching

The service worker precaches the versioned app shell. Navigation uses network-first with an offline shell fallback. Journal API reads use network-first and may fall back to explicitly stored IndexedDB snapshots; mutation requests are never cached as responses. Audio is not automatically cached after durable upload, though still-pending local capture remains in IndexedDB. A new service-worker version waits until the UI can safely prompt for activation so it does not interrupt recording.

## 9. HTTP and event API

All routes are under `/api/v1`. JSON request and response bodies validate with shared Zod schemas. Mutations require `Idempotency-Key`; editable resources use `If-Match`/ETag. Collection routes use cursor pagination with deterministic `(created_at, id)` or domain-specific ordering. Binary downloads support HTTP ranges.

Primary resources are:

- `/auth/*`: bootstrap, passkey challenge/verification, password recovery/login, session/logout.
- `/journal-days` and `/journal-days/{date}`: calendar summaries and complete day views.
- `/contributions`: typed and nudge-response creation, revision, movement, and deletion.
- `/recordings`: resumable chunks, finalization, status, ranged audio access, retry, audio-only deletion.
- `/transcripts`: layer inspection, corrected-text revisions, cleanup retry, audio seek metadata.
- `/processors` and `/processor-versions`: configuration, version creation, enablement, requirement mode, dry-run validation.
- `/processing-runs`: status, provenance, retry, cancel, reprocess preview, and explicit execution.
- `/artifacts`: observations/interpretations, evidence inspection, corrections, split/merge/supersede, manual overrides.
- `/memories` and `/feedback`: visible rule lifecycle and scoped corrections.
- `/nudges`: digest, respond, defer, dismiss, and not-applicable actions.
- `/search`: lexical retrieval, semantic retrieval, filters, and grounded-answer requests.
- `/exports`, `/retention`, and `/backups`: preview, start, status, download, and policy management.
- `/events`: authenticated SSE stream for upload, run, artifact, nudge, and export changes.

The API returns source material and generated synthesis in distinct fields/types. Every synthesized search answer includes citations to artifact/source IDs and evidence ranges or explicitly reports insufficient evidence (SEARCH-003, SEARCH-004, SEARCH-007).

## 10. Asynchronous processing

### 10.1 Job model

`pg-boss` queues are separated by capability: `transcription`, `cleanup`, `processor`, `embedding`, `export`, and `maintenance`. Each job contains identifiers only; the worker reloads canonical inputs from PostgreSQL and blob storage. Provider concurrency, timeout, and rate limits are configurable per adapter. Queue tables live in the dedicated `pgboss` schema, with retention policies that bound completed-job growth and a connection budget that leaves capacity for interactive journal traffic.

API services and workers import `pg-boss` directly. Job creation that follows an application mutation uses the active Drizzle/PostgreSQL transaction so canonical state and its queued work commit atomically. Maintenance and scheduled jobs use `pg-boss` cron/scheduling directly. Queue dependencies, retries with exponential backoff, priorities, dead-letter behavior, singleton/debounce policies, and worker concurrency use native `pg-boss` options rather than parallel application mechanisms.

A stage's idempotency fingerprint is a hash of stage type, exact input revision IDs/hashes, processor/prompt version, provider/model configuration, and relevant memory/context version. A successful matching run can be reused. Retry creates a new attempt linked to the original run while preserving its audit record. Exponential backoff with jitter applies only to classified transient errors; validation, unsupported media, and authentication errors require intervention (STATE-001–STATE-005).

Run statuses are `queued`, `running`, `succeeded`, `insufficient_information`, `stale`, `failed`, `canceled`, or `superseded`. Partial output is stored only with `completeness: partial` and is never used as complete day-level state.

### 10.2 Processing dependency graph

```text
durable recording
  → raw STT run
  → corrected transcript initialization
  → cleaned transcript
  → contribution-scoped processors ─┐
typed/nudge contribution ───────────┤
                                    ▼
                         day-scoped reconciliation
                           → observations
                           → interpretations
                           → requirement evaluation
                           → nudge digest
                           → lexical/semantic index
```

Dependencies reference exact revisions. When a corrected transcript changes, a database transaction updates its current pointer, traverses `artifact_inputs`, marks downstream cleanup/artifacts/index fragments stale, and emits replacement work. Editing an observation invalidates only dependent interpretations; it does not retranscribe audio (EDIT-001, EDIT-002).

Large historical reprocessing first produces a preview with dates, run count, affected processor versions, stale artifacts, manual overrides, and an estimated provider-operation count. Confirmation creates a batch record with cancel/progress state. Historical results remain queryable through audit views, and reports never mix processor semantics without labeling versions or selecting a normalized version (EDIT-003–EDIT-008).

### 10.3 AI provider interfaces

The `ai` package defines ports by capability:

- `SpeechToTextProvider.transcribe(audio, context, config)` returns exact raw response, normalized text/segments, language, model identity, and timestamp capability.
- `StructuredGenerationProvider.generate(schema, messages, config)` returns schema-validated data, raw response reference, token/usage metadata when available, and model identity.
- `EmbeddingProvider.embed(fragments, config)` returns vectors with provider/model/dimension metadata.

Provider-specific adapters are selected by configuration and registered through factories. Domain and processor code never imports a provider SDK. The effective request configuration and content-bearing context are snapshotted or reconstructable from immutable versions. Unknown provider fields and missing timestamps degrade explicitly, not as failed transcription (MODEL-001–MODEL-006, STT-003–STT-005).

External model calls receive only the minimum sources required for the declared stage. Before enabling an adapter, settings display the provider, capabilities, configured model identifiers, and known retention/training disclosure. Disabling a provider stops new jobs without making prior sources/results unreadable (SEC-004–SEC-006).

### 10.4 Processor runtime

Each processor version declares:

- kind: source transform, observation extractor, interpretation, or other declared operation;
- input scope: contribution, journal day, date range, observation set, or artifact set;
- input selectors and dependency processor versions;
- immutable instructions and prompt-template hash;
- JSON Schema output contract and semantic version;
- reconciliation key/strategy;
- optional/required mode and nudge policy;
- capability requirements such as structured generation or embeddings.

The runtime builds a bounded input bundle with stable source labels and temporal context, calls deterministic code and/or a configured provider, validates output, and passes proposed changes to the reconciler. Provider output cannot directly issue SQL or mutate canonical records. Evidence ranges are verified against the cited immutable source revision before storage. Invalid ranges or payloads fail the run visibly.

Built-in processors encode the FOOD, MOOD, SLEEP, TASK, and SUM rules from the product specification in both instructions and deterministic validators. Examples such as another person's food, tentative intentions, absent mood, wake-date sleep association, and later clarification reconciliation are permanent regression fixtures (AC-020–AC-024).

## 11. Temporal semantics

Every contribution stores:

- `captured_at`: immutable UTC instant;
- `captured_timezone`: IANA zone at capture;
- `journal_date`: explicit ISO date used for grouping;
- `journal_timezone`: configured zone used when the date was assigned;
- assignment source (`default`, `user_override`, or `migration`).

Temporal extraction receives these values, never the worker's current clock. A resolved phrase stores the original phrase, resolved value, IANA timezone, journal/capture context, resolution rule/version, confidence, and manual-override state. `Temporal` semantics are supplied through the standard API where available and `@js-temporal/polyfill` elsewhere; business logic does not use implicit local `Date` parsing.

Nightly sleep defaults to the wake date. Naps and multiple sleep periods have distinct logical IDs. Ambiguity remains uncertain and reviewable rather than being forced to a timestamp (TIME-004–TIME-007, SLEEP-001–SLEEP-004, AC-040, AC-041).

## 12. Search and grounded answers

`search_fragments` stores independently addressable fragments for selected typed-text/transcript revisions, observations, interpretations, summaries, and approved memories. Each row contains source type/ID/revision, journal date, manual/generated status, processor/version when applicable, plain text, a PostgreSQL weighted `tsvector`, deletion/staleness state, and optional embedding metadata/vector.

Lexical search uses PostgreSQL full-text search with deterministic ranking and phrase/prefix support. Filters apply in SQL before pagination. Semantic search is available only when an embedding provider is enabled and searches compatible model/dimension cohorts. Hybrid search combines normalized lexical and vector ranks with reciprocal-rank fusion; it never mixes incompatible embeddings.

Grounded answers use only retrieved, non-deleted fragments. The prompt labels each fragment with an opaque citation ID; returned citations are validated against the supplied set and mapped back to journal days and precise evidence. If support is inadequate, the answer says so. Reindex events are transactional with source changes; query paths exclude deleted or stale fragments immediately even before physical index cleanup (SEARCH-001–SEARCH-007).

## 13. Frontend application

### 13.1 Structure and state

Route-level areas are Today/Journal Day, Calendar, Search, Processors, Memories & Rules, Processing Activity, Exports/Backups, and Settings. Vue Router lazy-loads route chunks. TanStack Vue Query owns remote/cache state; Pinia owns session-wide UI workflow state only; local component state remains local. Shared API DTOs come from `contracts`.

The Journal Day view visually presents a coherent timeline while retaining contribution boundaries. Every generated result exposes evidence/provenance inspection and universal feedback. Source layers—audio, raw STT, corrected transcript, cleaned transcript—are explicitly labeled, and generated versus manual data is never communicated by color alone (DATA-003, AC-010–AC-012).

### 13.2 daisyUI and accessibility

UI implementation uses daisyUI components and semantic theme classes/tokens rather than hard-coded palette colors. Custom Vue components wrap repeated domain behavior, not generic daisyUI primitives without added value. Themes meet WCAG 2.2 AA contrast.

All workflows are keyboard-operable on desktop and touch-operable on Firefox Mobile. Controls have accessible names; status changes use appropriately throttled live regions; focus moves predictably after dialogs/errors; evidence highlighting has a textual equivalent. Automated axe checks supplement, but do not replace, keyboard and screen-reader test cases.

### 13.3 Responsive and failure-aware UX

Mobile is the primary capture layout. Recording controls remain reachable with one hand, survive route changes through a top-level capture controller, and prominently show local/durable state. The UI remains usable while stages are pending or failed and offers stage-specific retries. It does not label a provider failure as missing user information.

Calendar summaries load bounded month data. Day details and long transcripts use pagination/virtualization where necessary. Audio uses HTTP range requests and seeks from evidence time ranges when available.

## 14. Authentication, privacy, and security

### 14.1 Authentication and sessions

First run bootstraps exactly one owner account. Passkeys/WebAuthn are the preferred strong-authentication mechanism using `@simplewebauthn`; a password protected with current OWASP-recommended Argon2id parameters is available for bootstrap/recovery. Recovery codes are random, single-use, and stored hashed. Authentication endpoints are rate-limited even on localhost.

The server issues a random opaque session token in an `HttpOnly`, `SameSite=Strict` cookie. `Secure` is mandatory outside the localhost development exception. Sessions have idle and absolute expirations, rotate after authentication or privilege-sensitive changes, and can be individually revoked. State-changing requests require a same-origin CSRF token. CORS is disabled unless an explicit allowlist is configured.

### 14.2 Application security

- Helmet configures CSP and defensive headers; the production CSP does not permit inline scripts.
- Zod validates all external input. SQL is parameterized through Drizzle; storage keys are application-generated.
- Uploads verify declared media metadata, sniffed type where feasible, checksums, and streaming limits per chunk. Uploaded content is never executed or served with active content types.
- Secrets are read from environment/secret files outside journal storage, validated at startup, redacted from logs, and never returned by APIs or exports.
- Local data directories and backup files use owner-only permissions. Hosted deployments must use encrypted managed disks/databases and private blob containers; TLS is mandatory outside localhost.
- Destructive/admin commands append audit events. Journal text, transcript text, AI prompts/responses, audio, credentials, session tokens, and third-party memories are excluded from logs by default.
- Dependency, container, and secret scanning run in CI. Security updates follow the normal locked dependency update process.

No analytics or telemetry leaves the installation by default. Optional future telemetry must be opt-in and content-free (SEC-001–SEC-009).

## 15. Export, backup, restore, and portability

Exports are asynchronous, point-in-time jobs that stream a ZIP archive without loading the corpus into memory. A complete export contains:

- `manifest.json` with schema/export versions and checksums;
- JSON Lines for journal days, contributions, all text/transcript revisions, artifacts/versions, evidence, processor definitions/versions, memories/rules, feedback, nudges, timezones, provenance, and retention metadata;
- human-readable Markdown organized by journal date;
- selected original audio and provider raw responses in stable relative paths;
- a relationship index using stable UUIDs.

The export schema is documented and versioned. Unknown/none/neutral/not-applicable states and authority/manual overrides remain tagged, not flattened. Export downloads are authenticated, time-limited, and audited (PORT-003–PORT-008, AC-050–AC-052).

Local backup tooling takes a consistent PostgreSQL dump—including required `pg-boss` schema state—blob objects, configuration metadata without secrets, and checksums into an encrypted archive. Default schedule is daily incremental/logical backup with a documented retention policy; exact scheduling is configurable because the initial application runs only when the local host is available. Restore runs into an empty target, validates checksums and referential integrity, rebuilds derived search indexes, and resumes only non-terminal jobs whose run state still requires work. CI tests backup/restore on representative fixtures; an operator-facing restore drill is documented (PORT-001, PORT-002).

## 16. Observability and operations

Pino emits structured JSON logs with timestamp, severity, service, correlation ID, route template, status, latency, run/job IDs, and stable error code. A deny-by-default serializer prevents request/response bodies and journal data from being logged. OpenTelemetry instruments HTTP, database, queue, storage, and provider latency; the initial local exporter may be console/file-disabled by default.

Health endpoints are split:

- `/health/live`: process event loop is responsive;
- `/health/ready`: required PostgreSQL/storage dependencies are available; API readiness does not require an AI provider;
- `/health/details`: authenticated owner view of PostgreSQL and `pg-boss`, queue backlog, storage, migrations, and configured provider capability status.

Metrics include capture/finalization success, staging age, job queue age, stage outcomes/retries, stale artifact count, provider latency/rate-limit failures, search indexing lag, and backup/export outcomes. Metrics use IDs and counts, never content.

Graceful shutdown stops new HTTP requests/jobs, completes or safely abandons active chunk writes, asks `pg-boss` workers to stop within a bounded grace period, and then closes PostgreSQL connections. Job expiration, retries, and worker heartbeats allow work abandoned by a crashed worker to be recovered safely.

## 17. Local development and deployment

The initial environment is localhost only:

1. pnpm runs the web, API, and worker in watch mode.
2. Docker Compose runs PostgreSQL with `pgvector` in a named local volume; no separate queue service is required.
3. Blob data is stored in a configured application-data directory outside Git.
4. Vite proxies `/api` to Express so the browser uses one origin.
5. Localhost's browser secure-context exception supports service workers, media capture, and WebAuthn; non-localhost access requires HTTPS.

Configuration is parsed once at process startup by the shared config package. A checked-in `.env.example` documents non-secret settings. Production/staging environment assumptions are intentionally deferred until deployment is selected; deployment-specific work must add an ADR covering TLS termination, network boundaries, secret management, PostgreSQL service levels and queue connection budget, Azure storage, backup destination, and disaster recovery.

Application and `pg-boss` schema migrations run as an explicit, single deployment step before application rollout, never concurrently from every replica. Workers start only after the expected application and `pg-boss` schema versions are present. Seed commands create queues, schedules, built-in processor definitions, and development fixtures idempotently.

## 18. Testing and quality gates

### 18.1 Test layers

| Layer | Tools and responsibility |
| --- | --- |
| Static | TypeScript, ESLint, Prettier check, dependency-boundary and OpenAPI generation checks. |
| Unit/domain | Vitest; state machines, semantic value types, temporal rules, reconciliation, staleness, idempotency, prompt assembly, redaction. |
| Component | Vitest, Vue Test Utils, Testing Library, axe; daisyUI-rendered workflows, offline/status/error UI, accessibility. |
| API integration | Vitest, Supertest, Testcontainers PostgreSQL; transactions, migrations, auth, range requests, and atomic application/job insertion. |
| Adapter contract | Shared suites for blob stores and fake/real-shape AI adapters; immutable writes, ranges, checksums, missing capability behavior. |
| Worker integration | `pg-boss` with Testcontainers PostgreSQL and deterministic fake providers; retries, scheduling, crash recovery, fingerprints, dependency invalidation. |
| PWA/offline | Playwright with network state and browser context controls; reload recovery, outbox replay, cache isolation, service-worker upgrade. |
| End-to-end | Playwright; source-to-result workflows, corrections, search citations, export, deletion, and recovery. Firefox is mandatory; Chromium may run additionally. |

Tests that implement a normative requirement include IDs in their title, for example `[CAP-004][AC-002] resumes an interrupted upload without duplication`. A generated traceability report maps each acceptance criterion to at least one automated test or an explicitly documented manual verification. Requirement IDs are also used in permanent domain regression fixtures.

Property-based tests with `fast-check` cover idempotency, reconciliation, semantic-state serialization, date/timezone round trips, and dependency-graph invalidation. Provider tests use recorded synthetic responses with no real journal content. Tests never require a paid provider account unless placed in a separate opt-in suite.

### 18.2 Required quality gates

Every pull request and main-branch commit must pass:

1. formatting and lint checks;
2. TypeScript build/typecheck for all packages;
3. unit and component tests;
4. API/database/queue integration tests from a clean migration;
5. Firefox Playwright critical-path tests;
6. production builds for web, API, and worker;
7. dependency, secret, and container scans;
8. export/import and migration smoke tests.

Coverage is measured by package and risk, not only as a repository aggregate. Initial minimums are 90% statements/lines/functions and 85% branches for domain, contracts, storage, and processor packages; 80% statements/lines/functions and 75% branches elsewhere. Authentication, manual-authority protection, upload idempotency, deletion exclusion, and unknown-versus-zero logic require direct branch coverage regardless of totals.

## 19. Initial delivery sequence

1. **Foundation:** workspace, contracts, local infrastructure, migrations, authentication, logging/redaction, empty Vue shell.
2. **Durable text journal:** journal days, typed contribution revisions, offline outbox/cache, calendar/day UI, deletion grace period.
3. **Recoverable audio:** IndexedDB chunk capture, resumable upload/finalization, immutable local blobs, range playback.
4. **Transcript lineage:** provider interface, asynchronous STT, raw/corrected/cleaned layers, revision history, evidence timing.
5. **Processor platform:** versioned definitions, runtime validation, provenance graph, staleness, reconciliation, manual overrides, feedback/memory.
6. **Built-in processors and nudges:** food, mood, sleep, tasks, summaries/accomplishments, required-state evaluation and digest.
7. **Retrieval and portability:** PostgreSQL full-text search, optional embeddings/grounded answers, export, backup/restore, retention sweeper.
8. **Hardening:** complete acceptance traceability, Firefox Mobile verification, accessibility review, provider failure drills, large-recording soak tests.

Each increment preserves source data without depending on later AI features. No phase may introduce generated data as the only record of user content.

## 20. Requirement implementation map

| Requirement group | Primary implementation sections |
| --- | --- |
| ARCH, DATA, PROV | 3, 6, 10 |
| CAP, STT | 6.3, 7, 8, 10.2–10.3 |
| MEM, FB | 6.5, 9, 13 |
| PROC, FOOD, MOOD, TASK, SUM | 6.4, 10.4 |
| NUDGE, SEM | 6.1, 6.5, 10.4 |
| TIME, SLEEP | 6.2, 11 |
| EDIT, STATE | 6.4, 9, 10.1–10.2 |
| SEARCH | 9, 12 |
| RET | 6.1, 7.3, 15 |
| SEC | 8.4, 14, 16 |
| PORT | 7, 15 |
| MODEL | 6.4, 10.3 |
| AC acceptance criteria | 18 and the relevant functional section above |

## 21. Deferred decisions

The following are deliberately deferred because the high-level overview does not select a hosted deployment:

- cloud/runtime host and network topology;
- managed PostgreSQL product, capacity, and connection-pooling topology;
- final Azure container/account layout and managed-identity configuration;
- backup destination and hosted retention service-level objectives;
- specific AI vendors and default model identifiers;
- notification delivery outside the in-app PWA experience;
- multi-device conflict policy beyond optimistic concurrency and explicit merge;
- cross-user or shared-journal support, which is outside current scope.

These choices must not change stable IDs, source immutability, manual authority, exported semantics, or provider/storage ports. Each selected hosted design requires an ADR and conformance tests against the contracts in this specification.
