# Final requirement-to-test traceability report

- Status: Final local-release audit through Phase 8 Task 55
- Date: 2026-09-02
- Normative source: [`AI-Integrated-Journaling-Application-Specification.md`](../AI-Integrated-Journaling-Application-Specification.md)
- Delivery source: [`implementation-plan.md`](implementation-plan.md)

## How to use this matrix

This report checks every current normative requirement and acceptance criterion
against tracked automated evidence. A range is inclusive only of identifiers
actually defined by the product specification; numbering gaps are not implied
requirements. Exact paths name the current evidence rather than a planned suite.

Tests that exercise normative behavior include every applicable requirement ID
in their title or containing suite title. `scripts/operations.test.mjs` expands
ranges, compares tracked test metadata with the normative specification, and
fails unless all 182 IDs are present. A `Verified` row means its listed
behavioral evidence passed the final repository gate; it does not convert a
documented physical observation into an automated claim.

## Final coverage totals

| Evidence set | Result | Exact authority |
| --- | --- | --- |
| Normative product requirements | 161/161 have tracked automated evidence metadata and verified rows below | Product specification plus `scripts/operations.test.mjs` |
| Acceptance criteria | 21/21 verified | Individual AC rows below |
| Product edge cases | 25/25 automated and verified | Edge-case table below |
| Deterministic fault domains | 10/10 automated and verified | `docs/reliability-and-fault-testing.md` |
| Security abuse/control areas | 12/12 traced to behavioral evidence; dated dependency/secret/container scan limits remain explicit | `docs/security-and-privacy-review.md` |
| Accessibility/Firefox domains | 10/10 automated profiles passed Task 54; 7 supplementary physical observations remain NOT RUN | `docs/accessibility-firefox-mobile-validation.md` |
| Operations/recovery surfaces | 10/10 have executable commands or repeatable procedures; environment-dependent execution is reported below | `docs/operations-and-release.md` |

No normative requirement or acceptance criterion is left Planned or Partial.
External-provider behavior uses deterministic provider contracts because the
release installs no real external adapter. Physical backup media and real-device
observations are limitations, not invented release evidence.

## Evidence families

| Key | Primary layer and verified scope | Implementation-plan tasks |
| --- | --- | --- |
| `STATIC-BOUNDARY` | Dependency-boundary and package-export checks | 7 |
| `DOMAIN-KERNEL` | Vitest unit/property tests for IDs, revisions, authority, semantic values, time, and lifecycle policies | 9 |
| `CONTRACT` | Zod/OpenAPI fixtures, compatibility diff, problem details, cursors, ETags, and idempotency metadata | 10 |
| `DB-JOURNAL` | Testcontainers integration tests for migrations, journal repositories, revisions, deletion, and transactions | 11, 16 |
| `API-OPS` | Supertest integration tests for validation, auth, redaction, health, SSE replay, and shutdown | 12, 15, 17 |
| `WORKER` | pg-boss/Testcontainers tests for lifecycle, retry, fingerprinting, isolation, and recovery | 13, 27, 32, 52 |
| `UI-PWA` | Vue component/accessibility tests and Playwright offline/cache/status workflows | 14, 18, 19 |
| `AUDIO` | Blob adapter contracts, upload/API integration, browser capture, recovery, and range-playback tests | 21–25 |
| `TRANSCRIPT` | Provider contract, worker, dependency/evidence, API, and transcript UI tests | 26–30 |
| `PROCESSOR` | Processor schema, DAG, runtime, provenance, reconciliation, authority, reprocessing, and memory tests | 31–37 |
| `BUILTINS` | Permanent synthetic processor fixtures and component tests | 38–42 |
| `NUDGE` | Domain, scheduler/worker, API, and UI tests for requirement evaluation and digest behavior | 43 |
| `SEARCH` | Database/API/component/E2E tests for lexical, semantic, hybrid, and grounded retrieval | 44–46 |
| `RETENTION` | Database/blob/cache/index/export/backup deletion and restoration tests | 47, 52 |
| `PORTABILITY` | Streamed export and backup/restore contract, integration, and E2E tests | 48, 49 |
| `RELIABILITY` | Deterministic provider, queue-crash, missed-event, offline, duplication, staleness, concurrency, storage, export, and restore fault drills | 52 |
| `SECURITY` | Auth integration, threat-model regression, content-safe logging, scan, and destructive-audit checks | 15, 50, 53 |
| `RELEASE-E2E` | Testcontainers-backed source workflow plus Playwright Firefox acceptance and edge-case scenarios | 20, 25, 30, 37, 43, 48, 51–54 |
| `MANUAL-FIREFOX` | Repeatable physical Firefox Android checklist with device/browser version evidence | 4, 54 |
| `MANUAL-OPS` | Repeatable backup, restore, retention, provider-disclosure, and recovery drills | 49, 50, 55 |

## ADR conformance checks

| ADR | Evidence |
| --- | --- |
| ADR-0001 | `DOMAIN-KERNEL` verifies UUIDv7 generation, branding, collision/import behavior, and stable entity/revision separation; `STATIC-BOUNDARY` enforces package direction and declared exports. |
| ADR-0002 | `CONTRACT` verifies `/api/v1`, backward-compatible fixtures, OpenAPI drift, idempotency conflicts, ETags, RFC 9457 codes, and versioned SSE/persistence envelopes. |
| ADR-0003 | `DOMAIN-KERNEL` property tests and `CONTRACT` fixtures round-trip each exact tagged state and reject `null`, invalid confidence, illegal domain states, and falsy-value coercion. |
| ADR-0004 | `DOMAIN-KERNEL` and `PROCESSOR` directly cover field/whole-artifact overrides, manual deletion, staleness, conflicts, relinquishment, and export/restore authority. |
| ADR-0005 | `PROCESSOR` covers immutable publication, semantic labels, exact dependencies, DAG rejection, fingerprints, targeted invalidation, history, and version-basis reporting. |
| ADR-0006 | `apps/api/test/text-journal-milestone.integration.ts` and `playwright/shell.spec.ts` apply the source-only release gates; later audio, transcript, and complete-release suites verify the expanded AC-001 and AC-003 behavior. |
| ADR-0007 | `spikes/queue-transactionality/queue-transactionality.test.mjs` proves that an application mutation and `pg-boss` job commit and roll back together through the official Drizzle adapter. |
| ADR-0008 | `AUDIO` verifies prepare/finalize/confirm recovery, immutable conflict handling, and conservative orphan discovery and sweeping. |
| ADR-0009 | `UI-PWA`, `TRANSCRIPT`, `PROCESSOR`, `NUDGE`, `RETENTION`, `PORTABILITY`, `SECURITY`, and `MANUAL-OPS` verify encrypted bounded caches, exact evidence coordinates, raw-response policy, snapshot exports, anti-resurrection tombstones, private processor/nudge defaults, and encrypted backup/restore. |
| ADR-0010 | `AUDIO`, `PORTABILITY`, `RELEASE-E2E`, `MANUAL-FIREFOX`, and `MANUAL-OPS` verify bounded units and requests, incremental manifests and I/O, flat-memory long recordings, quota/disk exhaustion, preserved checkpoints, range playback, and streamed export/backup/restore. |

## Architectural and data requirements

| Requirement(s) | Evidence | Owning task(s) | First complete milestone | Status |
| --- | --- | --- | --- | --- |
| ARCH-001–003 | Domain source/revision tests plus `packages/processors/test/provenance.test.ts` and `apps/worker/test/processor-runtime.integration.ts` enforce distinct source/observation/interpretation types, exact immutable input edges, and recorded-edge-only invalidation. | 9, 16, 33 | AI journal | Verified |
| ARCH-004 | `packages/domain/test/reconciliation.test.ts`, `packages/domain/test/artifact-editing.test.ts`, and `apps/web/test/artifact-review-panel.test.ts` prove generated proposals cannot replace, remove, or visually obscure active manual values. | 9, 35 | AI journal | Verified |
| ARCH-005 | `apps/api/test/text-journal-milestone.integration.ts` and `playwright/shell.spec.ts`: source capture/view/edit works with the provider unconfigured and worker stopped. | 12–14, 19, 20, 52 | Source-only journal; repeated later | Verified |
| DATA-001–004 | Domain/database tests plus `apps/api/test/text-journal-milestone.integration.ts` and `playwright/shell.spec.ts`: stable date-addressed days, zero/many contributions, and preserved boundaries. | 16–18 | Source-only journal | Verified |
| DATA-010–012 | Database/API/UI tests plus `apps/api/test/text-journal-milestone.integration.ts`: contribution metadata, independent lifecycle, and targeted edits. | 16–20 | Source-only journal | Verified |
| DATA-013 | `packages/database/test/nudges.integration.ts`, `apps/api/test/nudge-routes.test.ts`, and `apps/web/test/nudge-digest-card.test.ts` persist every answer/dismissal as an owner-scoped contribution linked to the exact nudge item. | 16–19, 43 | Complete local release | Verified |
| DATA-020–021 | `apps/api/test/recording-service.integration.ts`, `apps/api/test/recording-routes.test.ts`, `packages/storage/test/blob-store-contract.ts`, and `apps/web/test/recording-sync.test.ts` cover preallocated recording identity, immutable streamed finalization, Journal Day projection, reopened synchronization, and conflicting/idempotent retries. | 21–25 | Audio journal | Verified |
| DATA-022–023 | `packages/test-support/test/fake-ai.test.ts` and `apps/worker/test/transcription-pipeline.integration.ts` cover immutable exact raw bytes plus persisted normalized provider/model/configuration/context/language/timing metadata and append-only raw revisions. | 26–27 | Transcript journal | Verified |
| DATA-024–026 | `apps/worker/test/transcription-pipeline.integration.ts`, `apps/api/test/transcript-service.integration.ts`, `apps/api/test/transcript-routes.test.ts`, and `apps/web/test/transcript-inspector.test.ts` cover distinct logical layers, generated initialization, append-only manual correction history, exact corrected-revision cleanup inputs, immutable prior revisions, and inspectable UI history. | 28–30 | Transcript journal | Verified |
| DATA-027–028 | `packages/test-support/test/fake-ai.test.ts`, `packages/database/test/transcript-evidence-migration.integration.ts`, `apps/worker/test/transcription-pipeline.integration.ts`, `apps/api/test/transcript-service.integration.ts`, and `apps/web/test/transcript-inspector.test.ts` cover persisted timed and explicitly untimed valid results, stable segment IDs, exact UTF-16/audio ranges, audio seeking, and a clear valid-but-unavailable timing state. | 26, 27, 29, 30 | Transcript journal | Verified |
| DATA-030 | `packages/processors/test/index.test.ts`, `apps/api/test/processor-service.integration.ts`, `apps/api/test/processor-routes.test.ts`, and `apps/web/test/processors-view.test.ts` validate every required definition field, stable identity, immutable version history, enablement, and current-version behavior. | 31 | AI journal | Verified |
| DATA-031 | `apps/worker/test/processor-runtime.integration.ts`, `apps/api/test/artifact-service.integration.ts`, and `apps/web/test/artifact-review-panel.test.ts` persist the full generated envelope and prove immutable manual revisions/candidates remain inspectable with authority and staleness. | 31–35 | AI journal | Verified |
| DATA-032–033 | `packages/processors/test/runtime.test.ts` and `apps/worker/test/processor-runtime.integration.ts` validate processor payloads against their immutable extensible schemas, reject undeclared fields, preserve explicit semantic states, and store JSONB without inventing unknown optionals. | 9, 10, 31, 32 | AI journal | Verified |
| PROV-001–002 | `packages/processors/test/runtime.test.ts` and `apps/worker/test/processor-runtime.integration.ts` verify exact source-revision evidence ranges/quote hashes plus exact interpretation-to-observation result IDs and output selectors. | 29, 32, 33 | AI journal | Verified |
| PROV-003 | Domain evidence tests, transcript worker integration, processor provenance property tests, and processor worker integration cover canonical coordinates, unresolved/stale evidence, transitive traversal, and exclusion of sibling/ancestor results. | 29, 33 | AI journal | Verified |
| PROV-004 | `apps/web/test/transcript-inspector.test.ts`, `apps/api/test/processor-service.integration.ts`, `apps/worker/test/processor-runtime.integration.ts`, and `apps/web/test/artifact-review-panel.test.ts` expose exact source/artifact inputs, evidence, processor/prompt version, provider/model/configuration, attempts, correction authority, and staleness without content-bearing prompts. | 30, 33, 35, 51 | AI journal | Verified |

## Capture, transcription, memory, and feedback

| Requirement(s) | Evidence | Owning task(s) | First complete milestone | Status |
| --- | --- | --- | --- | --- |
| CAP-001 | `apps/web/test/journal-day-view.test.ts` and `playwright/task-54-mobile.spec.ts` render independently identified typed and recorded contributions together on one Journal Day. | 22–25 | Audio journal | Verified |
| CAP-002–003 | `apps/web/test/capture-controller.test.ts`, `apps/web/test/indexed-db.test.ts`, `apps/web/test/offline-journal.test.ts`, `apps/web/test/recording-sync.test.ts`, and `playwright/shell.spec.ts` cover encrypted immediate persistence, reload, atomic checkpoints, accepted-index resume, preserved prefixes, and cleanup only after durable confirmation. | 23–25 | Audio journal | Verified |
| CAP-004 | `apps/api/test/recording-service.integration.ts`, `apps/api/test/recording-routes.test.ts`, `apps/web/test/recording-sync.test.ts`, and `playwright/shell.spec.ts` cover duplicate create/chunk/finalize retries, uniqueness, missing-only upload, conflict suppression, and one durable synchronized identity. | 22, 24, 25 | Audio journal | Verified |
| CAP-005 | `apps/web/test/capture-controller.test.ts` covers 5-second timeslices, bounded 8 MiB units, quota checks, a 256-checkpoint session, and preserved prefixes; `apps/web/test/recording-sync.test.ts`, `apps/worker/test/export.test.ts`, and `packages/database/test/backup-tool.test.mjs` cover incremental upload/archive/recovery. Physical multi-hour capture remains NOT RUN. | 21–25, 48, 49, 52, 54 | Audio journal; portability repeated later | Verified |
| CAP-006 | `apps/web/test/capture-controller.test.ts`, `apps/web/test/recording-sync.test.ts`, `apps/web/test/journal-components.test.ts`, and `playwright/task-54-mobile.spec.ts` cover accessible recording, locally saved, uploading, durable, transcription-pending, storage, failure, and safe-retry states. | 23–25 | Audio journal | Verified |
| CAP-007 | `apps/web/test/capture-controller.test.ts`, `apps/web/test/recording-sync.test.ts`, `apps/web/test/journal-components.test.ts`, and `apps/api/test/journal-routes.test.ts` cover the complete alternate-day assignment/reassignment workflow while retaining immutable capture time and timezone. | 22–25 | Audio journal | Verified |
| STT-001–002 | `apps/api/test/recording-service.integration.ts`, `apps/worker/test/transcription-pipeline.integration.ts`, `apps/api/test/recording-routes.test.ts`, and `apps/web/test/journal-components.test.ts` cover durable-gated asynchronous STT, visible failure, preserved audio, and linked safe retry. | 27, 30 | Transcript journal | Verified |
| STT-003–005 | `apps/worker/test/transcription-pipeline.integration.ts` and memory persistence tests cover exact requested/effective context plus deterministic approved-memory snapshots bound to immutable revision IDs. | 26, 27, 37 | AI journal | Verified |
| MEM-001–002 | Domain, API, integration, transcript, and feedback-dialog tests prove occurrence correction remains local unless remember is explicitly chosen. | 37 | AI journal | Verified |
| MEM-003 | `apps/api/test/memory-service.integration.ts` proves an AI suggestion is visible but inactive until explicit approval. | 37 | AI journal | Verified |
| MEM-004–005 | API/service and accessible Vue tests cover bounded search, visible scopes/creator/approval, immutable edit history, enable/disable, and soft deletion. | 37 | AI journal | Verified |
| MEM-006–007 | `apps/api/test/memory-service.integration.ts`, `apps/worker/test/transcription-pipeline.integration.ts`, and `docs/security-and-privacy-review.md` prove only visible approved eligible memory revisions enter context; inferred facts remain inactive and owner-protected. | 37, 53 | AI journal | Verified |
| FB-001–003 | Transcript and generic artifact surfaces expose the same feedback flow; API/service tests bind targets exactly and return the visible resulting rule. | 37 | AI journal | Verified |
| FB-004 | Domain and service tests prove omitted or incomplete intent resolves to occurrence-only and incompatible broad scopes fail closed. | 37 | AI journal | Verified |

## Processor, semantic, temporal, and built-in behavior

| Requirement(s) | Evidence | Owning task(s) | First complete milestone | Status |
| --- | --- | --- | --- | --- |
| PROC-001–004 | Processor contract, API/service integration, route, client, and accessible component tests cover first-class create/configure/enable flows plus declared kind and input scope/selectors. | 31 | AI journal | Verified |
| PROC-005 | `packages/domain/test/reconciliation.test.ts`, `packages/database/test/processor-reconciliation.integration.ts`, `apps/worker/test/processor-runtime.integration.ts`, and built-in processor tests cover stable-key create/update/supersede/remove/unchanged behavior, partial preservation, worker integration, domain reconciliation, and concurrent whole-day serialization. | 34, 38–42 | AI journal | Verified |
| PROC-006–008 | Processor definition, runtime, provenance property, API, and worker integration tests cover immutable definitions, exact dependency DAGs, selected artifact bindings, prompt/schema hashes, provider configuration, extensible payloads, and inspectable historical results. | 31–33 | AI journal | Verified |
| PROC-009–010 | `packages/processors/test/runtime.test.ts` and the food, mood, sleep, tasks, and summary processor tests reject invented fields/precision, preserve explicit unknown separately from known zero, express uncertainty, and require partial labeling. | 32, 38–42 | AI journal | Verified |
| NUDGE-001–003 | `packages/domain/test/nudges.test.ts`, `packages/database/test/nudges.integration.ts`, and `apps/web/test/nudge-digest-card.test.ts` cover exact states and required-only evaluation; Task 31 retains definition configuration coverage. | 31, 43 | Complete local release | Verified |
| NUDGE-004 | `packages/domain/test/nudges.test.ts` and `packages/database/test/nudges.integration.ts`: only complete successful-enough evaluation can create insufficiency/nudge work. | 43 | Complete local release | Verified |
| NUDGE-005–006 | `packages/database/test/nudges.integration.ts`, `apps/api/test/nudge-routes.test.ts`, and `apps/web/test/nudge-digest-card.test.ts`: consolidation, concurrency, limits, quiet hours, all actions, and durable response linkage. | 43 | Complete local release | Verified |
| NUDGE-007 | `packages/domain/test/nudges.test.ts`, `packages/database/test/nudges.integration.ts`, and `apps/web/test/nudge-digest-card.test.ts`: failure is visually and semantically distinct from omitted information. | 43, 51 | Complete local release | Verified |
| SEM-001 | `packages/domain/test/semantic-authority.test.ts`, `packages/domain/test/nudges.test.ts`, and `packages/contracts/test/contracts.test.ts` round-trip every ADR-0003 tagged state including known zero without truthiness coercion. | 9, 10 | Foundation | Verified |
| SEM-002–003 | `packages/domain/test/semantic-authority.test.ts`, `packages/processors/test/food-and-drink.test.ts`, and `packages/processors/test/mood.test.ts` prove absent mood and food do not become neutral, none, or zero. | 9, 38, 39 | AI journal | Verified |
| SEM-004 | `packages/processors/test/mood.test.ts`, `packages/processors/test/summary-and-accomplishments.test.ts`, and `apps/web/test/artifact-review-panel.test.ts` exclude unknown, neutral, and uncertain aggregate states from numeric averages and label the distinction. | 39, 42, 46 | Complete local release | Verified |
| SEM-005 | `packages/domain/test/semantic-authority.test.ts`, `packages/contracts/test/contracts.test.ts`, `apps/web/test/artifact-review-panel.test.ts`, and `apps/worker/test/export.test.ts` preserve state distinctions through domain, wire, UI, and portable export representations. | 10, 18, 48 | Complete local release | Verified |
| TIME-001–003 | Domain/database tests, `apps/api/test/text-journal-milestone.integration.ts`, and `playwright/shell.spec.ts`: capture instant/date/zones round trip and manual moves do not silently reassign. | 9, 16–20 | Source-only journal | Verified |
| TIME-004–006 | Domain temporal tests plus `packages/processors/test/sleep-and-temporal.test.ts` verify relative and ambiguous language uses immutable contribution context and retains the original phrase, basis, timezone, and uncertainty. | 9, 40 | AI journal | Verified |
| TIME-007 | Domain authority/reconciliation tests plus the sleep temporal correction fixture prove corrected dates remain authoritative and generated disagreement stays reviewable. | 9, 35, 40 | AI journal | Verified |
| SLEEP-001–004 | `packages/processors/test/sleep-and-temporal.test.ts` and `apps/web/test/artifact-review-panel.test.ts` cover wake-date defaulting, disclosed correction, distinct naps/periods, unknown optional fields, exact evidence, and accessible review. | 40 | AI journal | Verified |
| FOOD-001–002 | `packages/processors/test/food-and-drink.test.ts` covers the exact AC-020 ownership fixture, consumption-only prompt contract, retained evidence links, and semantic rejection of non-owner events. | 38 | AI journal | Verified |
| FOOD-003–004 | Food schema/validator tests preserve supported optional fields, omit unknown caffeine/alcohol, retain “some” as qualitative, and reject fabricated normalized precision. The food result-card test preserves those distinctions in the UI. | 38 | AI journal | Verified |
| FOOD-005–007 | Food-specific stable-key tests reconcile later clarification across the whole day; domain/database/API/UI tests protect field corrections and explicit split/merge/correct/delete/confirm behavior under manual authority. | 34, 35, 38 | AI journal | Verified |
| MOOD-001–003 | `packages/processors/test/mood.test.ts` and the artifact-card component test preserve mixed contextual observations as independent logical artifacts beneath one separately inspectable aggregate with exact evidence. | 39 | AI journal | Verified |
| MOOD-004 | `packages/processors/test/mood.test.ts`, `apps/web/test/artifact-review-panel.test.ts`, and `packages/database/test/nudges.integration.ts` preserve absent mood as explicit unknown insufficient information, never neutral/numeric, through requirement evaluation. | 39, 43 | Complete local release | Verified |
| MOOD-005 | Mood reconciliation tests retain a manual aggregate rating while exposing the generated disagreement as a candidate; generic database/API/UI tests enforce the same authority rule. | 35, 39 | AI journal | Verified |
| MOOD-006 | Immutable mood instructions, deterministic validation tests, and result-card copy prohibit clinical/diagnostic claims and label output as journaling analysis. | 39 | AI journal | Verified |
| TASK-001–003 | `packages/processors/test/tasks-and-intentions.test.ts` and the accessible artifact-card test distinguish all six action/intention classes, bind due dates to exact temporal evidence, and enforce observation-only output with no external-task authority. | 41 | AI journal | Verified |
| TASK-004–005 | Tasks/intentions schema, fixtures, validator, reconciliation tests, and cards preserve broader remember categories and ensure completed-only actions never become pending tasks. | 41 | AI journal | Verified |
| SUM-001–003 | `packages/processors/test/summary-and-accomplishments.test.ts` and accessible artifact-card tests keep narrative and bullets separate, grounded, and free of invented significance/tone. | 42 | AI journal | Verified |
| SUM-004–005 | Processor reconciliation, artifact persistence/API, and accessible component tests verify edit/add/remove/pin authority survives reprocessing while the Journal Day retains the complete bullet list. | 35, 42 | AI journal | Verified |

## Editing, lifecycle, retrieval, retention, security, and portability

| Requirement(s) | Evidence | Owning task(s) | First complete milestone | Status |
| --- | --- | --- | --- | --- |
| EDIT-001–002 | Transcript and processor worker integration plus provenance property tests cover corrected/source revision replacement, exact recorded-edge traversal through observations/interpretations, sibling/ancestor exclusion, stale evidence, canceled obsolete work, and identifier-only replacement jobs without retranscription. | 29, 33 | AI journal | Verified |
| EDIT-003–004 | Contract/domain, PostgreSQL service, API route/client, and accessible Activity-view tests cover contribution, Journal Day, date-range, processor, and processor-version scopes; bounded previews disclose exact versions, affected data, stale/manual impact, and approximate provider calls before idempotent confirmation. | 36 | AI journal | Verified |
| EDIT-005 | Processor reconciliation, artifact-editing, and reprocessing integration tests verify stable identity, append-only generated/manual revisions, explicit supersession, retained batch/run history, and cancellation that does not remove completed results. | 33–36 | AI journal | Verified |
| EDIT-006–007 | Domain, database/API integration, API contract/client, and accessible component tests prove active manual fields and tombstones survive reprocessing while disagreements become separately adoptable/dismissible candidates. | 35, 36 | AI journal | Verified |
| EDIT-008 | `packages/contracts/test/contracts.test.ts`, `apps/api/test/reprocessing-service.integration.ts`, `apps/web/test/processing-activity-view.test.ts`, and `apps/worker/test/export.test.ts` store/export and expose a resolved immutable processor-version basis. | 31, 36, 48 | Complete local release | Verified |
| STATE-001 | `packages/domain/test/reprocessing.test.ts`, `packages/database/test/queue.integration.ts`, `apps/worker/test/processor-runtime.integration.ts`, and `apps/web/test/processing-activity-view.test.ts` verify durable lifecycle transitions and visible progress/cancellation/history. | 13, 27, 32, 43 | Complete local release | Verified |
| STATE-002–003 | Provider-fault worker tests preserve canonical source data while persisting content-free retry policy; real pg-boss integration recovers expired claims and reloads canonical state; Journal Day UI/E2E keeps sources usable and exposes affected-stage retry. See `docs/reliability-and-fault-testing.md`. | 13, 27, 32, 52 | AI journal | Verified |
| STATE-004 | `apps/worker/test/processor-runtime.integration.ts` verifies identifier-only fingerprints, completed-run replay, exact version/config lineage, one result per run, and worker reconciliation. `packages/database/test/processor-reconciliation.integration.ts` verifies duplicate-delivery replay, whole-day advisory locking, and database uniqueness enforcement. | 13, 27, 32, 34 | AI journal | Verified |
| STATE-005 | `packages/processors/test/runtime.test.ts` requires explicitly partial output for a bounded partial input, processor run/result rows persist completeness separately, and `packages/database/test/processor-reconciliation.integration.ts` proves unseen current artifacts are retained during partial reconciliation. | 13, 32, 34 | AI journal | Verified |
| STATE-006–007 | `apps/api/test/text-journal-milestone.integration.ts`, `apps/web/test/offline-journal.test.ts`, and `playwright/shell.spec.ts`: source durability and journal use do not depend on optional processing. | 12–14, 19, 20 | Source-only journal | Verified |
| SEARCH-001 | `packages/database/test/search.integration.ts`, `apps/api/test/search-routes.test.ts`, `apps/web/test/search-view.test.ts`, and `playwright/shell.spec.ts` verify deterministic phrase/prefix retrieval across selected current source/result layers with exact revisions and stable cursors. | 44 | Complete local release | Verified |
| SEARCH-002 | Domain/property, provider-neutral worker, PostgreSQL cohort/vector/lifecycle, API fallback/fusion, component/a11y, and Firefox tests verify optional exact-cohort semantic retrieval and deterministic hybrid ranking. | 45 | Complete local release | Verified |
| SEARCH-003–004 | Search/grounded-answer domain, database, worker, API, `apps/web/test/search-view.test.ts`, and `playwright/shell.spec.ts` keep inert retrieved quotes distinct from synthesis and navigate validated citations to exact revisions/UTF-16 evidence. | 44–46, 51 | Complete local release | Verified |
| SEARCH-005 | PostgreSQL/API tests compose date, contribution, processor, result, entity, authority, and layer filters before deterministic lexical, exact-cohort semantic, and RRF hybrid pagination/ranking. | 44, 45 | Complete local release | Verified |
| SEARCH-006 | `packages/database/test/search.integration.ts`, `packages/database/test/search-migration.integration.ts`, `packages/database/test/retention.integration.ts`, and grounded-answer tests immediately exclude replaced, deleted, stale, partial, superseded, disabled, unapproved, or tombstoned text/vectors and suppress stale synthesis. | 44–47 | Complete local release | Verified |
| SEARCH-007 | Domain citation validation, deterministic fake-provider worker tests, empty-retrieval database tests, API/component tests, and Firefox coverage require explicit `insufficient_support` instead of an invented answer and distinguish provider failure. | 46 | Complete local release | Verified |
| RET-001–003 | `packages/domain/test/retention.test.ts`, `packages/database/test/retention.integration.ts`, `packages/database/test/settings.integration.ts`, `apps/web/test/settings-view.test.ts`, and `docs/retention-and-permanent-deletion.md` cover independent defaults, policy, grace, and retained audio metadata. | 47, 50, 55 | Complete local release | Verified |
| RET-004–005 | `apps/api/test/recording-service.integration.ts`, `apps/api/test/retention-routes.test.ts`, `apps/web/test/journal-components.test.ts`, and `packages/database/test/retention.integration.ts` cover recoverable audio/material deletion, explicit impact/backup warnings, and audio-only permanent cleanup with transcript retention. | 47, 51 | Complete local release | Verified |
| RET-006–007 | Domain/contracts, real-PostgreSQL retention integration, worker retry/idempotency, IndexedDB purge, browser API tests, export invalidation, and backup tooling cover grace, tombstone-first bounded deletion across rows/revisions/blobs/staging/text/vectors/caches/outboxes/raw responses, anti-resurrection, configured checkpoint gating, and newest-ledger restore replay. Task 52 restores an older snapshot against a newer permanent-deletion checkpoint and verifies purge-before-rebuild/resume. | 47–49, 52 | Complete local release | Verified |
| SEC-001–003 | `docs/security-and-privacy-review.md` plus auth/config/storage/API/component tests verify singleton bootstrap, strong hashed credentials, opaque bounded sessions, CSRF, owner scoping, secret separation, encrypted private cache, loopback-only exposure, and no client/log/export credential leakage. | 15, 19, 53 | Complete local release | Verified |
| SEC-004–006 | AI/settings/service/UI/worker tests and `docs/security-and-privacy-review.md` verify pre-enablement recipient/retention/training/HTTPS-policy disclosure, acknowledgement, disabled-by-default providers, write-only encrypted credentials, prompt isolation, and data-only validated results. | 26, 50, 53 | Complete local release | Verified |
| SEC-007 | Deny-by-default observability/API/reliability tests and processor worker integration verify content-free logs, errors, and identifier-only queue jobs; the Task 53 review traces every logger/queue boundary. | 12, 52, 53 | Complete local release | Verified |
| SEC-008 | Journal, recording, artifact, memory, settings, export, retention, and auth tests cover owner-scoped destructive/admin operations and correlation-linked content-free audits, including bootstrap, recovery, passkeys, logout, and permanent deletion. | 11, 15, 47, 53 | Complete local release | Verified |
| SEC-009 | Memory authorization/export/deletion tests and `docs/security-and-privacy-review.md` verify third-party memories use the same owner scoping, content-free logging, export, and deletion controls. | 37, 47, 48, 53 | Complete local release | Verified |
| PORT-001–002 | `packages/database/test/backup-tool.test.mjs`, `packages/database/test/retention.integration.ts`, `apps/worker/test/backup.test.ts`, and `docs/backup-and-restore.md` cover encrypted coordinated PostgreSQL/pg-boss/blob/config snapshots, checksum failure, documented retention, empty-target enforcement, newest tombstone replay, search rebuilding, canonical job reconciliation, and a repeatable quarterly drill. | 49, 55 | Complete local release | Verified |
| PORT-003–006 | `packages/contracts/test/export.test.ts`, `packages/database/test/export.integration.ts`, `apps/worker/test/export.test.ts`, `apps/api/test/export-routes.test.ts`, `apps/web/test/exports-view.test.ts`, and `playwright/shell.spec.ts` verify selected streamed ZIP64 audio/raw content, stable relationships, checksums, and human/machine forms. | 48 | Complete local release | Verified |
| PORT-007 | Export tests serialize tagged semantic and authority states; task 49's complete PostgreSQL logical dump/restore preserves those exact database values while rebuilding only derived retrieval indexes. | 9, 48, 49 | Complete local release | Verified |
| PORT-008 | `packages/storage/test/blob-store-contract.ts`, `packages/ai/test/index.test.ts`, `apps/worker/test/export.test.ts`, and `packages/database/test/backup-tool.test.mjs` prove replaceable storage/provider boundaries and portable export/empty-target recovery without a named provider host. | 21, 26, 48, 49 | Complete local release | Verified |
| MODEL-001 | `packages/ai/test/index.test.ts` verifies capability-based ports and factory resolution without provider SDK dependencies. | 26 | Transcript journal | Verified |
| MODEL-002 | AI port fixtures plus transcription/processor worker integration and processor provenance API tests persist and expose provider/model/effective configuration, exact reconstructable prompt/processor versions, processing time, raw response, requested inputs/configuration, and cross-artifact lineage. | 26, 27, 32, 33 | AI journal | Verified |
| MODEL-003–005 | `packages/ai/test/index.test.ts`, `packages/test-support/test/fake-ai.test.ts`, `apps/worker/test/transcription-pipeline.integration.ts`, and structured/embedding worker tests cover factories, switching, explicit capability absence, persisted configurations, and timed/untimed results. | 26, 27, 32 | AI journal | Verified |
| MODEL-006 | `packages/test-support/test/fake-ai.test.ts`, `apps/worker/test/transcription-pipeline.integration.ts`, `apps/worker/test/retention.test.ts`, and `apps/worker/test/export.test.ts` cover immutable bytes, integrity, do-not-retain/expiry policy, retrieval, deletion, and explicit export inclusion. | 26, 27, 47, 48, 50 | Complete local release | Verified |

## Acceptance criteria

Acceptance criteria receive individual rows because they are release evidence, even where lower-level requirement tests cover the same invariant.

| Criterion | Evidence | Owning task(s) | First complete milestone | Status |
| --- | --- | --- | --- | --- |
| AC-001 | `apps/web/test/journal-day-view.test.ts`, “displays two recordings and one editable typed note as distinct contributions when transcription fails,” renders exactly two independently identified audio cards and one typed card inside one three-contribution Journal Day. | 18, 20, 25, 51 | Audio journal | Verified |
| AC-002 | `apps/web/test/recording-sync.test.ts`, “reopens an interrupted upload and completes the same durable recording without duplication,” persists the failed local state/checkpoints, constructs a new controller as a reopened application, uploads only the missing index, does not recreate the server recording, and cleans up only after durable confirmation. `apps/api/test/recording-service.integration.ts` independently proves server-side create/chunk/finalize replay and uniqueness. | 24, 25, 51 | Audio journal | Verified |
| AC-003 | `apps/web/test/journal-day-view.test.ts`, “displays two recordings and one editable typed note as distinct contributions when transcription fails,” proves failed transcription leaves original audio playable with retry and typed text editable. `apps/api/test/text-journal-milestone.integration.ts` proves the typed source remains durable/editable across an API restart while the provider is unconfigured and the worker is stopped. | 20, 25, 30, 51 | Transcript journal | Verified |
| AC-010 | `apps/api/test/transcript-service.integration.ts`, `apps/api/test/transcript-routes.test.ts`, and `apps/web/test/transcript-inspector.test.ts` inspect original audio beside explicitly distinct raw STT, corrected, and cleaned artifacts. | 30, 51 | Transcript journal | Verified |
| AC-011 | `apps/worker/test/transcription-pipeline.integration.ts`, `apps/api/test/transcript-service.integration.ts`, and `apps/web/test/transcript-inspector.test.ts` prove a correction leaves raw text/provider bytes unchanged, preserves manual authority/history, marks exact prior cleanup/evidence stale, and visibly queues replacement cleanup. | 28–30 | Transcript journal | Verified |
| AC-012 | Domain/provider/database/worker evidence tests plus `apps/api/test/transcript-service.integration.ts` and `apps/web/test/transcript-inspector.test.ts` prove exact timed audio navigation and a clear valid-but-timing-unavailable state. | 26, 29, 30, 51 | Transcript journal | Verified |
| AC-020 | `packages/processors/test/food-and-drink.test.ts`: exact burrito/Nicolette fixture yields an empty consumption-event set. | 38 | AI journal | Verified |
| AC-021 | `packages/processors/test/food-and-drink.test.ts` and `apps/web/test/artifact-review-panel.test.ts`: pizza clarification retains one stable logical key and renders one event with both exact evidence spans. | 38 | AI journal | Verified |
| AC-022 | `packages/processors/test/mood.test.ts` and `apps/web/test/artifact-review-panel.test.ts` prove absent mood yields explicit unknown insufficient information, is never neutral, and is excluded from averages. | 39, 43 | Complete local release | Verified |
| AC-023 | Mood processor and accessible result-card tests preserve morning/evening observations as separate logical artifacts with exact evidence beneath a separately inspectable aggregate. | 39 | AI journal | Verified |
| AC-024 | `packages/processors/test/tasks-and-intentions.test.ts` and `apps/web/test/artifact-review-panel.test.ts` preserve a tentative idea as possible and a firm dated obligation as pending with exact due-date phrase, context, and evidence. | 41 | AI journal | Verified |
| AC-030 | Transcript, feedback-dialog, service, and domain tests prove a transcript edit creates no global rule without the distinct explicitly approved remember command. | 37, 51 | AI journal | Verified |
| AC-031 | Memory route/service/component/accessibility tests list, search, edit, disable, and soft-delete active persistent memories while preserving immutable history. | 37, 51 | AI journal | Verified |
| AC-032 | Direct behavioral fixtures cover every named authority branch: `packages/processors/test/mood.test.ts` (manual mood plus generated candidate), `food-and-drink.test.ts` (manual quantity), `tasks-and-intentions.test.ts` (manual task date), `sleep-and-temporal.test.ts` (manual temporal correction), `summary-and-accomplishments.test.ts` (edited/pinned/added/removed bullets), and `apps/worker/test/transcription-pipeline.integration.ts` (manual corrected transcript survives regenerated cleanup while raw/history remain immutable). | 35–42, 51 | AI journal | Verified |
| AC-040 | `apps/web/test/recording-sync.test.ts`, `apps/web/test/journal-components.test.ts`, `apps/api/test/journal-routes.test.ts`, and `packages/processors/test/sleep-and-temporal.test.ts` cover the 00:30 prior-day reassignment and downstream immutable temporal context while retaining the instant and timezone. | 24, 25, 40 | AI journal | Verified |
| AC-041 | `packages/processors/test/sleep-and-temporal.test.ts` and its property suite verify that tomorrow retains the original phrase, contextual basis, timezone, and date resolved from the contribution's effective Journal Day. | 40 | AI journal | Verified |
| AC-042 | `packages/database/test/nudges.integration.ts` and `apps/web/test/nudge-digest-card.test.ts`: three missing requirements form one digest and day dismissal prevents repeat default prompts. | 43, 51 | Complete local release | Verified |
| AC-043 | `packages/domain/test/nudges.test.ts`, `packages/database/test/nudges.integration.ts`, and `apps/web/test/nudge-digest-card.test.ts`: technical failure renders failed state and never insufficient-information copy/nudge. | 43, 51 | Complete local release | Verified |
| AC-050 | Export database/worker/API/UI tests materialize every relevant immutable layer with stable IDs, stream selected audio/raw bodies, extract the standalone ZIP, and verify its versioned manifest and every file checksum. | 48, 51 | Complete local release | Verified |
| AC-051 | `apps/web/test/artifact-review-panel.test.ts` exposes exact source revisions/evidence, processor definition/version, instruction and prompt hashes, provider/model, run ID, completion, and processing duration; export worker tests preserve the same provenance records. | 33, 48, 51 | Complete local release | Verified |
| AC-052 | `packages/test-support/test/fake-ai.test.ts`, “switches providers without changing the captured source or earlier result,” executes STT with provider A, switches to provider B, and directly compares the immutable source and prior A result. `apps/worker/test/export.test.ts` proves the historical provider result/raw body remains independently readable in a portable archive. | 26, 48, 51 | Complete local release | Verified |

## Product edge-case table

All 25 rows in section 22 of the product specification are repeatably automated. The identifiers below are traceability labels for this matrix; they do not add product requirements.

| Edge | Product scenario | Automated behavioral proof | Status |
| --- | --- | --- | --- |
| EC-01 | Multiple recordings in one day | `apps/web/test/journal-day-view.test.ts`, `[CAP-001][STATE-002][STATE-003][AC-001][AC-003]`, renders two independently identified recordings and one typed source in a single three-item day timeline. | Verified |
| EC-02 | Recording after midnight about the prior waking day | `apps/web/test/recording-sync.test.ts`, `[CAP-007][AC-040]`, moves the recording to the prior date while preserving capture instant/timezone; `packages/processors/test/sleep-and-temporal.test.ts`, `[SLEEP-001][SLEEP-002][TIME-004][AC-040]`, applies wake-date semantics downstream. | Verified |
| EC-03 | Travel across timezones | `packages/domain/test/identity-temporal.test.ts`, “keeps capture and journal temporal context distinct and immutable,” stores a London capture zone, Los Angeles journal zone, overridden prior date, and frozen context; journal move/restart tests verify persisted items are not reassigned. | Verified |
| EC-04 | No timestamps from STT | `apps/web/test/transcript-inspector.test.ts`, `[AC-012][DATA-028]`, renders an untimed transcript as valid and explicitly timing-unavailable, not failed. | Verified |
| EC-05 | Raw STT is wrong but cleaned text looks plausible | `apps/api/test/transcript-service.integration.ts`, `[AC-011][DATA-026][EDIT-001][ARCH-004][MEM-002][STATE-004]`, keeps raw STT immutable, appends the correction, stales prior cleanup/results, and queues regeneration; the inspector test exposes all three values separately. | Verified |
| EC-06 | Correction changes “Monday” to “Tuesday” | `apps/web/test/feedback-memory-dialog.test.ts`, `[MEM-001][MEM-002][FB-001][FB-004][AC-030]`, submits that exact correction as `occurrence_only` and verifies no hidden persistent memory is created. | Verified |
| EC-07 | Name correction recurs | `apps/api/test/memory-service.integration.ts`, `[MEM-003][MEM-006][MEM-007][FB-003]`, creates a visible Nicolette known-entity suggestion that remains disabled and excluded from STT context until explicit approval. | Verified |
| EC-08 | User mentions another person's meal | `packages/processors/test/food-and-drink.test.ts`, `[AC-020][FOOD-001][FOOD-002]`, uses the exact Nicolette fixture and produces no owner consumption event. | Verified |
| EC-09 | User says they bought or considered food | The same `[AC-020][FOOD-001][FOOD-002]` fixture proves buying does not imply consumption; food validator tests reject non-consumption semantics. | Verified |
| EC-10 | Later food statement adds quantity/detail | `packages/processors/test/food-and-drink.test.ts`, `[AC-021][FOOD-005][FOOD-006]`, reconciles the two-slice clarification into the same stable event with both evidence spans. | Verified |
| EC-11 | User had a bad morning and good evening | `packages/processors/test/mood.test.ts`, `[AC-023][MOOD-001–003][PROV-001]`, preserves separate contextual observations beneath a separately inspectable aggregate. | Verified |
| EC-12 | Mood is not discussed | `packages/processors/test/mood.test.ts`, `[AC-022][MOOD-004][SEM-002][SEM-004]`, emits explicit unknown/insufficient information and excludes it from averages. | Verified |
| EC-13 | “I slept badly last night” in Monday's journal | `packages/processors/test/sleep-and-temporal.test.ts`, `[SLEEP-001][SLEEP-002][TIME-004][AC-040]`, associates nightly sleep with the Monday wake date while retaining phrase, context, evidence, and correction support. | Verified |
| EC-14 | Nap plus nightly sleep | `packages/processors/test/sleep-and-temporal.test.ts`, `[SLEEP-003][SLEEP-004]`, retains separate stable nap and nightly-sleep periods without invented fields. | Verified |
| EC-15 | “Maybe I should…” | `packages/processors/test/tasks-and-intentions.test.ts`, `[AC-024][TASK-001][TASK-002]`, preserves the tentative idea separately from a firm dated obligation. | Verified |
| EC-16 | “I called the dentist” | `packages/processors/test/tasks-and-intentions.test.ts`, `[TASK-001][TASK-004][TASK-005]`, classifies the exact statement as completed and does not create a pending task. | Verified |
| EC-17 | Processor/API outage | `apps/api/test/text-journal-milestone.integration.ts` and `apps/web/test/journal-day-view.test.ts` keep sources usable; `apps/worker/test/transcription-pipeline.integration.ts`, `apps/worker/test/processor-runtime.integration.ts`, `apps/worker/test/search-embedding.test.ts`, and `apps/worker/test/grounded-answer.test.ts` inject rate limits/outages and verify content-free classification plus canonical retry. | Verified |
| EC-18 | Upload interrupted | `apps/web/test/recording-sync.test.ts`, `[CAP-002][CAP-003][CAP-004][AC-002]`, reopens saved checkpoints, resumes the same server identity, uploads only the missing chunk, and reaches one durable recording. | Verified |
| EC-19 | Transcript edited after extraction | `apps/worker/test/transcription-pipeline.integration.ts` and `apps/api/test/transcript-service.integration.ts`, `[EDIT-001][AC-011]`, invalidate only recorded dependents and never present superseded cleanup/results as current. | Verified |
| EC-20 | Reprocessing conflicts with manual rating | `packages/processors/test/mood.test.ts`, `[MOOD-005][AC-032][ARCH-004]`, keeps the manual rating effective and exposes generated disagreement as a review candidate. | Verified |
| EC-21 | Required processor fails technically | `packages/database/test/nudges.integration.ts`, `[NUDGE-002][NUDGE-004][NUDGE-005][NUDGE-007][AC-042][AC-043]`, excludes the failed evaluation from missing-information items; the UI labels it as technical failure. | Verified |
| EC-22 | User dismisses a nudge | `packages/database/test/nudges.integration.ts`, `[DATA-013][NUDGE-005][NUDGE-006][AC-042]`, persists the linked day dismissal response and prevents a repeated default digest. | Verified |
| EC-23 | Audio deleted, transcript retained | `packages/database/test/retention.integration.ts`, `[RET-002][RET-004][RET-006][RET-007]`, permanently removes audio objects/staging while directly asserting the transcript revision and non-playable recording metadata remain. | Verified |
| EC-24 | Processor schema evolves | `apps/api/test/processor-service.integration.ts`, `[PROC-006][PROC-008]`, publishes a changed version while directly re-reading the unchanged historical definition; processor result/export tests retain exact versioned payloads. | Verified |
| EC-25 | Search answer lacks support | `apps/worker/test/grounded-answer.test.ts`, `[SEARCH-007][MODEL-004][STATE-003]`, distinguishes insufficient journal evidence from provider capability failure; `apps/web/test/search-view.test.ts` renders insufficient support separately from generation failure. | Verified |

## Task 55 operations evidence

The following commands were exercised on 2026-09-02 in the release workspace
with Node.js 24.18.0, pnpm 11.22.0 through Corepack, Docker 29.7.2, and a
disposable blob directory. No private journal content or secret values were
printed or copied into this report.

| Surface | Exact evidence and result |
| --- | --- |
| Configuration safety | `corepack pnpm local:start -- --check` accepted a writable disposable `BLOB_DATA_DIR`. The checked-in local environment's unwritable blob ancestor was rejected before Docker changes with only the field-policy failure shown. Parser tests prove `$()` text is data, malformed assignments and unresolved references fail, and exported overrides win. |
| Startup plan | `corepack pnpm local:start -- --dry-run` printed the exact ordered seven-command plan without executing it: configuration check, Docker check, infrastructure up, data bootstrap, migrations, seed, and development processes. |
| Cold preparation and migrations | `corepack pnpm local:start -- --prepare-only` passed twice against PostgreSQL. Both runs reported completed migrations and the same idempotent seed reconciliation: 10 queues, 4 schedules, 6 processors, and 7 development fixtures requested. Standalone `corepack pnpm db:migrate`, `db:seed`, and `data:bootstrap` also loaded the protected root environment and passed. |
| Running health | Full `corepack pnpm local:start` reached Vite ready, worker ready, and API listening. `/health/live` and `/health/ready` each returned `{"status":"healthy"}`; the web origin returned HTTP 200. The foreground processes were then stopped with `Ctrl+C`. |
| Safe shutdown | `corepack pnpm infra:down` passed after the command's explicit root `.env` wiring was verified; the container/network were removed and the named database volume retained. |
| Backup command boundary | `corepack pnpm backup:init` loaded `.env` and safely refused unconfigured non-absolute backup storage before mutation. `packages/database/test/backup-tool.test.mjs` and `apps/worker/test/backup.test.ts` passed 9/9 deterministic encrypted backup, restore, retention, and scheduling tests. |
| Dependency status | `corepack pnpm audit --audit-level moderate` initially identified patched `fast-uri` and `qs` releases; after narrow workspace overrides, the repeated command reported `No known vulnerabilities found`. |
| Traceability guard | `scripts/operations.test.mjs` independently extracted 182 normative identifiers and requires all 182 in tracked automated-test metadata, valid documentation/evidence links, protected operational script wiring, and the final Task 55 state. |
| Environment-dependent checks | Physical restic/PostgreSQL-client backup and empty-target restore are **NOT RUN** because `restic`, `pg_dump`, and `pg_restore` are absent and backup paths are unconfigured. Current Gitleaks and Grype scans are **NOT RUN** because those binaries are absent; Task 53 results remain dated historical evidence. |
| Physical observations | Firefox Mobile device installation chrome, real process suspension, assistive-technology speech, real browser quota, and multi-hour soak remain the seven documented **NOT RUN** supplementary observations. They are not counted as automated success. |

The repository-wide validation result and exact suite totals are recorded here
only after the final gate completes; individual rows above describe commands
that were actually run, not planned release evidence.

## Maintenance rules

1. A change to the product specification updates this matrix in the same commit.
2. A test covering normative behavior includes bracketed IDs in its title, for example `[CAP-004][AC-002] resumes an interrupted upload without duplication`.
3. A test may satisfy multiple rows only when its assertions directly exercise each listed behavior; incidental execution is not coverage.
4. Manual evidence records date, environment/device version, exact procedure, expected result, actual result, and issue links.
5. `scripts/operations.test.mjs` fails when a normative specification ID has no tracked automated evidence metadata, when a concrete evidence path disappears, or when this report regresses to Planned/Partial status.
6. Requirements marked `SHOULD` need verified evidence or a documented justified deviation. Requirements marked `MAY` are tested when the technical specification or implementation selects the option.
