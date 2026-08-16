# Requirement-to-test matrix

- Status: Maintained through the Phase 2 text-journal milestone
- Date: 2026-08-16
- Normative source: [`AI-Integrated-Journaling-Application-Specification.md`](../AI-Integrated-Journaling-Application-Specification.md)
- Delivery source: [`implementation-plan.md`](implementation-plan.md)

## How to use this matrix

This matrix assigns every current normative requirement and acceptance criterion to planned verification before implementation begins. A range is inclusive of the identifiers actually defined by the product specification; gaps in numbering are not implied requirements.

Tests that exercise normative behavior must include every applicable requirement ID in the test title. As implementation lands, the owner replaces the planned suite key with the concrete test path and test name and changes the status only when that test passes in the required gate. A requirement may remain `Partial` until all rows or cross-layer scenarios needed to prove it are complete.

Status values are:

- `Planned`: owner and proof strategy selected; executable proof does not exist yet.
- `Partial`: some required proof exists, but the full behavior or milestone does not.
- `Verified`: all listed automated and manual evidence passes.
- `Manual`: automation is impractical and a repeatable manual procedure is linked.

## Planned verification suites

| Key | Primary layer and intended scope | Implementation-plan tasks |
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
| `SECURITY` | Auth integration, threat-model regression, content-safe logging, scan, and destructive-audit checks | 15, 50, 53 |
| `RELEASE-E2E` | Testcontainers-backed source workflow plus Playwright Firefox acceptance and edge-case scenarios | 20, 25, 30, 37, 43, 48, 51–54 |
| `MANUAL-FIREFOX` | Repeatable physical Firefox Android checklist with device/browser version evidence | 4, 54 |
| `MANUAL-OPS` | Repeatable backup, restore, retention, provider-disclosure, and recovery drills | 49, 50, 55 |

## ADR conformance checks

| ADR | Planned proof |
| --- | --- |
| ADR-0001 | `DOMAIN-KERNEL` verifies UUIDv7 generation, branding, collision/import behavior, and stable entity/revision separation; `STATIC-BOUNDARY` enforces package direction and declared exports. |
| ADR-0002 | `CONTRACT` verifies `/api/v1`, backward-compatible fixtures, OpenAPI drift, idempotency conflicts, ETags, RFC 9457 codes, and versioned SSE/persistence envelopes. |
| ADR-0003 | `DOMAIN-KERNEL` property tests and `CONTRACT` fixtures round-trip each exact tagged state and reject `null`, invalid confidence, illegal domain states, and falsy-value coercion. |
| ADR-0004 | `DOMAIN-KERNEL` and `PROCESSOR` directly cover field/whole-artifact overrides, manual deletion, staleness, conflicts, relinquishment, and export/restore authority. |
| ADR-0005 | `PROCESSOR` covers immutable publication, semantic labels, exact dependencies, DAG rejection, fingerprints, targeted invalidation, history, and version-basis reporting. |
| ADR-0006 | `apps/api/test/text-journal-milestone.integration.ts` and `playwright/shell.spec.ts` apply the source-only release gates; AC-001 and AC-003 retain partial status for their audio-dependent portions. |
| ADR-0007 | `spikes/queue-transactionality/queue-transactionality.test.mjs` proves that an application mutation and `pg-boss` job commit and roll back together through the official Drizzle adapter. |
| ADR-0008 | `AUDIO` verifies prepare/finalize/confirm recovery, immutable conflict handling, and conservative orphan discovery and sweeping. |
| ADR-0009 | `UI-PWA`, `TRANSCRIPT`, `PROCESSOR`, `NUDGE`, `RETENTION`, `PORTABILITY`, `SECURITY`, and `MANUAL-OPS` verify encrypted bounded caches, exact evidence coordinates, raw-response policy, snapshot exports, anti-resurrection tombstones, private processor/nudge defaults, and encrypted backup/restore. |
| ADR-0010 | `AUDIO`, `PORTABILITY`, `RELEASE-E2E`, `MANUAL-FIREFOX`, and `MANUAL-OPS` verify bounded units and requests, incremental manifests and I/O, flat-memory long recordings, quota/disk exhaustion, preserved checkpoints, range playback, and streamed export/backup/restore. |

## Architectural and data requirements

| Requirement(s) | Planned proof | Owning task(s) | First complete milestone | Status |
| --- | --- | --- | --- | --- |
| ARCH-001–003 | `DOMAIN-KERNEL`, `PROCESSOR`: enforce source/observation/interpretation types and exact input lineage/invalidation. | 9, 16, 33 | AI journal | Planned |
| ARCH-004 | `DOMAIN-KERNEL`, `PROCESSOR`: generated proposals cannot replace active manual values. | 9, 35 | AI journal | Planned |
| ARCH-005 | `apps/api/test/text-journal-milestone.integration.ts` and `playwright/shell.spec.ts`: source capture/view/edit works with the provider unconfigured and worker stopped. | 12–14, 19, 20, 52 | Source-only journal; repeated later | Verified |
| DATA-001–004 | Domain/database tests plus `apps/api/test/text-journal-milestone.integration.ts` and `playwright/shell.spec.ts`: stable date-addressed days, zero/many contributions, and preserved boundaries. | 16–18 | Source-only journal | Verified |
| DATA-010–012 | Database/API/UI tests plus `apps/api/test/text-journal-milestone.integration.ts`: contribution metadata, independent lifecycle, and targeted edits. | 16–20 | Source-only journal | Verified |
| DATA-013 | `DB-JOURNAL`, `API-OPS`, `UI-PWA`: durable linked nudge responses. | 16–19, 43 | Complete local release | Planned |
| DATA-020–021 | `AUDIO`: preallocated recording identity and immutable finalized audio/replacement behavior. | 21–25 | Audio journal | Planned |
| DATA-022–023 | `TRANSCRIPT`: immutable exact raw response and complete run provenance/capability metadata. | 26–27 | Transcript journal | Planned |
| DATA-024–026 | `TRANSCRIPT`: distinct raw/corrected/cleaned layers and append-only editable history. | 28–30 | Transcript journal | Planned |
| DATA-027–028 | `TRANSCRIPT`: retained timing enables seek; capability absence remains valid and explicitly unknown. | 26, 29, 30 | Transcript journal | Planned |
| DATA-030 | `PROCESSOR`: validate every required processor-definition field and stable identity/current-version behavior. | 31 | AI journal | Planned |
| DATA-031 | `PROCESSOR`: persist and inspect every common-envelope field, direct input, authority, staleness, and provenance field. | 31–35 | AI journal | Planned |
| DATA-032–033 | `CONTRACT`, `PROCESSOR`, `DOMAIN-KERNEL`: versioned extensible payloads remain readable and never invent unknown optionals. | 9, 10, 31, 32 | AI journal | Planned |
| PROV-001–002 | `TRANSCRIPT`, `PROCESSOR`: observations validate evidence exceptions; interpretations identify exact observations/sources. | 29, 32, 33 | AI journal | Planned |
| PROV-003 | `TRANSCRIPT`, `PROCESSOR`: editing preserves resolvable evidence or marks it unresolved/stale. | 29, 33 | AI journal | Planned |
| PROV-004 | `TRANSCRIPT`, `PROCESSOR`, `RELEASE-E2E`: inspector exposes evidence, versions, provider/model, and corrections. | 30, 33, 35, 51 | AI journal | Planned |

## Capture, transcription, memory, and feedback

| Requirement(s) | Planned proof | Owning task(s) | First complete milestone | Status |
| --- | --- | --- | --- | --- |
| CAP-001 | `AUDIO`, `RELEASE-E2E`: multiple typed/recorded contributions coexist independently on one day. | 22–25 | Audio journal | Planned |
| CAP-002–003 | `AUDIO`: IndexedDB remains recovery authority across interruption, suspension, closure, and reconnect until durable confirmation. | 23–25 | Audio journal | Planned |
| CAP-004 | `AUDIO`: duplicate create/chunk/finalize retries reuse identity and reject conflicting bytes. | 22, 24, 25 | Audio journal | Planned |
| CAP-005 | `AUDIO`, `PORTABILITY`, `MANUAL-FIREFOX`: timesliced long capture has no aggregate cap; bounded-memory upload/finalization/playback/export/backup preserves earlier chunks under interruption and quota/disk pressure. | 21–25, 48, 49, 52, 54 | Audio journal; portability repeated later | Planned |
| CAP-006 | `AUDIO`: component/E2E tests distinguish each local, upload, durable, pending, and failure state accessibly. | 23–25 | Audio journal | Planned |
| CAP-007 | `AUDIO`: alternate-day assignment preserves actual capture time and timezone. | 22–25 | Audio journal | Planned |
| STT-001–002 | `TRANSCRIPT`, `WORKER`: durable audio schedules async STT; failure preserves audio and safe retry. | 27, 30 | Transcript journal | Planned |
| STT-003–005 | `TRANSCRIPT`, `PROCESSOR`: approved global context is versioned/snapshotted; future scope is not required for baseline. | 26, 27, 37 | AI journal | Planned |
| MEM-001–002 | `PROCESSOR`, `RELEASE-E2E`: occurrence correction remains local unless remember is explicitly chosen. | 37 | AI journal | Planned |
| MEM-003 | `PROCESSOR`: suggested memory stays inactive until approval under the default policy. | 37 | AI journal | Planned |
| MEM-004–005 | `PROCESSOR`: active memories are searchable/manageable and retain scoped revision/audit metadata. | 37 | AI journal | Planned |
| MEM-006–007 | `PROCESSOR`, `SECURITY`: no hidden prompt profile; inferred facts remain visible unapproved suggestions. | 37, 53 | AI journal | Planned |
| FB-001–003 | `PROCESSOR`: all named artifact surfaces accept scoped feedback and display the resulting persistent rule. | 37 | AI journal | Planned |
| FB-004 | `PROCESSOR`: ambiguous feedback resolves to occurrence-only/narrowest safe scope. | 37 | AI journal | Planned |

## Processor, semantic, temporal, and built-in behavior

| Requirement(s) | Planned proof | Owning task(s) | First complete milestone | Status |
| --- | --- | --- | --- | --- |
| PROC-001–004 | `PROCESSOR`: first-class definitions support enable/configure/create, declared kind, and declared scope. | 31 | AI journal | Planned |
| PROC-005 | `PROCESSOR`, `BUILTINS`: whole-day reconciliation covers create/update/supersede/remove/unchanged without duplicates. | 34, 38–42 | AI journal | Planned |
| PROC-006–008 | `PROCESSOR`, `CONTRACT`: immutable version/schema provenance and backward-readable extensible payload fixtures. | 31–33 | AI journal | Planned |
| PROC-009–010 | `PROCESSOR`, `BUILTINS`: absence is not a negative fact; supported uncertainty replaces fabricated precision. | 32, 38–42 | AI journal | Planned |
| NUDGE-001–003 | `NUDGE`: required/optional configuration and exact initial evaluation states; optional defaults do not nudge. | 31, 43 | Complete local release | Planned |
| NUDGE-004 | `NUDGE`, `WORKER`: only successful-enough evaluation can create insufficiency/nudge work. | 43 | Complete local release | Planned |
| NUDGE-005–006 | `NUDGE`: digest consolidation, limits, answer/defer/dismiss/not-applicable, and durable response linkage. | 43 | Complete local release | Planned |
| NUDGE-007 | `NUDGE`, `RELEASE-E2E`: failure is visually and semantically distinct from omitted information. | 43, 51 | Complete local release | Planned |
| SEM-001 | `DOMAIN-KERNEL`, `CONTRACT`: property-based round trips preserve every ADR-0003 tagged state including known zero. | 9, 10 | Foundation | Planned |
| SEM-002–003 | `DOMAIN-KERNEL`, `BUILTINS`: absent mood/food/other domains never become neutral, none, or zero. | 9, 38, 39 | AI journal | Planned |
| SEM-004 | `BUILTINS`, `SEARCH`: statistics/summaries exclude or separately label unknown values and disclosed imputation. | 39, 42, 46 | Complete local release | Planned |
| SEM-005 | `CONTRACT`, `UI-PWA`, `PORTABILITY`: UI and export/import retain state distinctions. | 10, 18, 48 | Complete local release | Planned |
| TIME-001–003 | Domain/database tests, `apps/api/test/text-journal-milestone.integration.ts`, and `playwright/shell.spec.ts`: capture instant/date/zones round trip and manual moves do not silently reassign. | 9, 16–20 | Source-only journal | Verified |
| TIME-004–006 | `DOMAIN-KERNEL`, `BUILTINS`: relative/ambiguous language uses immutable contribution context and retains basis/uncertainty. | 9, 40 | AI journal | Planned |
| TIME-007 | `DOMAIN-KERNEL`, `PROCESSOR`: corrected date/time remains authoritative through reprocessing. | 9, 35, 40 | AI journal | Planned |
| SLEEP-001–004 | `BUILTINS`: wake-date default, disclosed correction, distinct naps/periods, and unknown optional fields. | 40 | AI journal | Planned |
| FOOD-001–002 | `BUILTINS`: consumption and ownership evidence exclude buying/planning/others eating. | 38 | AI journal | Planned |
| FOOD-003–004 | `BUILTINS`: optional food fields remain semantic values and qualitative quantity is not fabricated. | 38 | AI journal | Planned |
| FOOD-005–007 | `BUILTINS`, `PROCESSOR`: day reconciliation updates logical events and supports manual split/merge/correct/delete/confirm. | 34, 35, 38 | AI journal | Planned |
| MOOD-001–003 | `BUILTINS`: contextual observations remain separate from inspectable aggregate interpretation. | 39 | AI journal | Planned |
| MOOD-004 | `BUILTINS`: no mention produces insufficient information, never neutral. | 39, 43 | Complete local release | Planned |
| MOOD-005 | `BUILTINS`, `PROCESSOR`: manual observation/rating values survive reprocessing. | 35, 39 | AI journal | Planned |
| MOOD-006 | `BUILTINS`: validators and UI copy prohibit clinical-diagnosis framing. | 39 | AI journal | Planned |
| TASK-001–003 | `BUILTINS`: fixtures distinguish action/intention classes and prevent unapproved external-task creation. | 41 | AI journal | Planned |
| TASK-004–005 | `BUILTINS`: broader remember categories remain representable and completed-only actions do not create pending tasks. | 41 | AI journal | Planned |
| SUM-001–003 | `BUILTINS`: narrative and bullets remain separate, grounded, and free of invented significance/tone. | 42 | AI journal | Planned |
| SUM-004–005 | `BUILTINS`, `PROCESSOR`: edit/add/remove/pin survives reprocessing and calendar truncation preserves the full list. | 35, 42 | AI journal | Planned |

## Editing, lifecycle, retrieval, retention, security, and portability

| Requirement(s) | Planned proof | Owning task(s) | First complete milestone | Status |
| --- | --- | --- | --- | --- |
| EDIT-001–002 | `TRANSCRIPT`, `PROCESSOR`: exact dependency traversal marks only affected downstream artifacts stale. | 29, 33 | AI journal | Planned |
| EDIT-003–004 | `PROCESSOR`: every reprocessing scope has impact preview and explicit confirmation for large runs. | 36 | AI journal | Planned |
| EDIT-005 | `PROCESSOR`: immutable history and supersession remain inspectable after reconciliation/reprocessing. | 33–36 | AI journal | Planned |
| EDIT-006–007 | `PROCESSOR`: manual values win and conflicts create reviewable candidates. | 35, 36 | AI journal | Planned |
| EDIT-008 | `PROCESSOR`, `PORTABILITY`: reports expose version basis or explicitly normalized data. | 31, 36, 48 | Complete local release | Planned |
| STATE-001 | `WORKER`, `UI-PWA`: every stage stores and displays its independent exact lifecycle state. | 13, 27, 32, 43 | Complete local release | Planned |
| STATE-002–003 | `WORKER`, `RELEASE-E2E`: isolated failures preserve other stages and expose affected-stage retry. | 13, 27, 32, 52 | AI journal | Planned |
| STATE-004 | `WORKER`, `PROCESSOR`: retry fingerprint/attempt lineage prevents silent duplicate observations. | 13, 27, 32, 34 | AI journal | Planned |
| STATE-005 | `WORKER`, `PROCESSOR`: partial results remain labeled and ineligible as complete day state. | 13, 32 | AI journal | Planned |
| STATE-006–007 | `apps/api/test/text-journal-milestone.integration.ts`, `apps/web/test/offline-journal.test.ts`, and `playwright/shell.spec.ts`: source durability and journal use do not depend on optional processing. | 12–14, 19, 20 | Source-only journal | Verified |
| SEARCH-001 | `SEARCH`: deterministic selected-layer full-text retrieval. | 44 | Complete local release | Planned |
| SEARCH-002 | `SEARCH`: optional semantic retrieval is capability-gated and lifecycle aware. | 45 | Complete local release | Planned |
| SEARCH-003–004 | `SEARCH`, `RELEASE-E2E`: results/citations navigate to evidence and visually label source versus synthesis. | 44–46, 51 | Complete local release | Planned |
| SEARCH-005 | `SEARCH`: each specified filter composes before deterministic pagination/ranking. | 44, 45 | Complete local release | Planned |
| SEARCH-006 | `SEARCH`, `RETENTION`: deleted/private/stale fragments are immediately excluded and later removed. | 44–47 | Complete local release | Planned |
| SEARCH-007 | `SEARCH`: unsupported answers return explicit insufficient evidence with no invented claim. | 46 | Complete local release | Planned |
| RET-001–003 | `RETENTION`, `MANUAL-OPS`: default indefinite audio and independent configurable retention are persisted/disclosed. | 47, 50, 55 | Complete local release | Planned |
| RET-004–005 | `RETENTION`, `RELEASE-E2E`: warnings and impact previews cover audio-only, contribution, and day deletion. | 47, 51 | Complete local release | Planned |
| RET-006–007 | `RETENTION`, `PORTABILITY`: grace/recovery/hard-delete propagates across blobs, indexes, caches, exports, and backups. | 47–49, 52 | Complete local release | Planned |
| SEC-001–003 | `SECURITY`: authentication/session/access, secret separation, cache isolation, and no client/log/export credential exposure. | 15, 19, 53 | Source-only journal; repeated later | Planned |
| SEC-004–006 | `SECURITY`, `TRANSCRIPT`, `MANUAL-OPS`: provider content disclosure/disablement/minimization/retention information. | 26, 50, 53, 55 | Complete local release | Planned |
| SEC-007 | `API-OPS`, `SECURITY`: deny-by-default serializers and synthetic canary tests keep content out of diagnostics. | 12, 53 | Foundation | Planned |
| SEC-008 | `DB-JOURNAL`, `SECURITY`: administrative/destructive operations append content-safe audit events. | 11, 15, 47, 53 | Complete local release | Planned |
| SEC-009 | `PROCESSOR`, `SECURITY`: third-party memories follow identical authorization, logging, export, and deletion controls. | 37, 47, 48, 53 | Complete local release | Planned |
| PORT-001–002 | `PORTABILITY`, `MANUAL-OPS`: complete checksummed backup, retention policy, empty-target restore, and repeatable drill. | 49, 55 | Complete local release | Planned |
| PORT-003–006 | `PORTABILITY`: documented readable streamed exports include selected corpus/relationships and human/machine forms. | 48 | Complete local release | Planned |
| PORT-007 | `PORTABILITY`, `DOMAIN-KERNEL`: export/restore round trip preserves semantic and authority states. | 9, 48, 49 | Complete local release | Planned |
| PORT-008 | `PORTABILITY`, `TRANSCRIPT`: provider/storage adapters and exported corpus remain usable without original vendor/host. | 21, 26, 48, 49 | Complete local release | Planned |
| MODEL-001 | `TRANSCRIPT`: capability ports and adapter contracts contain no provider-specific domain dependency. | 26 | Transcript journal | Planned |
| MODEL-002 | `TRANSCRIPT`, `PROCESSOR`: every AI run records provider/model/configuration/prompt or processor version. | 26, 27, 32, 33 | AI journal | Planned |
| MODEL-003–005 | `TRANSCRIPT`, `PROCESSOR`: provider-switch fixtures preserve sources/history and represent unsupported capabilities explicitly. | 26, 27, 32 | AI journal | Planned |
| MODEL-006 | `TRANSCRIPT`, `PORTABILITY`, `RETENTION`: raw-response retention/export policy is explicit and lifecycle tested. | 26, 27, 47, 48, 50 | Complete local release | Planned |

## Acceptance criteria

Acceptance criteria receive individual rows because they are release evidence, even where lower-level requirement tests cover the same invariant.

| Criterion | Planned proof | Owning task(s) | First complete milestone | Status |
| --- | --- | --- | --- | --- |
| AC-001 | `apps/api/test/text-journal-milestone.integration.ts` and `playwright/shell.spec.ts` prove one day with independent typed contributions; `AUDIO`/`RELEASE-E2E` must still complete the two-recording-plus-text scenario. | 18, 20, 25, 51 | Audio journal | Partial |
| AC-002 | `AUDIO`, `RELEASE-E2E`: interrupt upload, reopen/reconnect, retry same identity, assert one durable recording. | 25, 51 | Audio journal | Planned |
| AC-003 | `apps/api/test/text-journal-milestone.integration.ts` proves that worker/provider failure leaves typed sources durable and editable across restart; repeat with an original recording after audio/STT milestones. | 20, 25, 30, 51 | Source-only partial; transcript journal complete | Partial |
| AC-010 | `TRANSCRIPT`, `RELEASE-E2E`: inspect audio and three explicitly distinct transcript layers. | 30, 51 | Transcript journal | Planned |
| AC-011 | `TRANSCRIPT`: correction leaves raw bytes/text unchanged and stales exact dependents. | 28–30 | Transcript journal | Planned |
| AC-012 | `TRANSCRIPT`, `RELEASE-E2E`: timed evidence seeks audio; untimed provider fixture shows unavailable timing. | 26, 29, 30, 51 | Transcript journal | Planned |
| AC-020 | `BUILTINS`: exact burrito/Nicolette fixture yields no user consumption. | 38 | AI journal | Planned |
| AC-021 | `BUILTINS`: pizza clarification reconciles to one logical event. | 38 | AI journal | Planned |
| AC-022 | `BUILTINS`: absent mood yields insufficient information and is excluded from averages. | 39, 43 | Complete local release | Planned |
| AC-023 | `BUILTINS`: morning/evening observations remain separate beneath an inspectable aggregate. | 39 | AI journal | Planned |
| AC-024 | `BUILTINS`: tentative idea and firm dated obligation retain different classifications. | 41 | AI journal | Planned |
| AC-030 | `PROCESSOR`, `RELEASE-E2E`: transcript edit creates no global rule without explicit remember approval. | 37, 51 | AI journal | Planned |
| AC-031 | `PROCESSOR`, `RELEASE-E2E`: list/edit/disable/delete every active persistent memory. | 37, 51 | AI journal | Planned |
| AC-032 | `PROCESSOR`: reprocess each named manual field/bullet and assert effective manual values are unchanged. | 35–37, 51 | AI journal | Planned |
| AC-040 | `AUDIO`, `BUILTINS`: 00:30 capture assigned to prior day retains instant and timezone. | 25, 40 | AI journal | Planned |
| AC-041 | `BUILTINS`: tomorrow retains phrase, contextual basis, timezone, and resolved date. | 40 | AI journal | Planned |
| AC-042 | `NUDGE`, `RELEASE-E2E`: three missing requirements form one digest and day dismissal prevents repeat default prompts. | 43, 51 | Complete local release | Planned |
| AC-043 | `NUDGE`, `RELEASE-E2E`: technical failure renders failed state and never insufficient-information copy/nudge. | 43, 51 | Complete local release | Planned |
| AC-050 | `PORTABILITY`: restore/standalone inspection resolves audio, layers, evidence, results, versions, and memories by stable IDs. | 48, 51 | Complete local release | Planned |
| AC-051 | `PROCESSOR`, `PORTABILITY`, `RELEASE-E2E`: inspector exposes sources/evidence/definition/instruction/provider/model/time. | 33, 48, 51 | Complete local release | Planned |
| AC-052 | `TRANSCRIPT`, `PORTABILITY`: switch fake configured provider and retain all earlier sources/results in UI/export. | 26, 48, 51 | Complete local release | Planned |

## Maintenance rules

1. A change to the product specification updates this matrix in the same commit.
2. A test covering normative behavior includes bracketed IDs in its title, for example `[CAP-004][AC-002] resumes an interrupted upload without duplication`.
3. A test may satisfy multiple rows only when its assertions directly exercise each listed behavior; incidental execution is not coverage.
4. Manual evidence records date, environment/device version, exact procedure, expected result, actual result, and issue links.
5. Task 51 closes any remaining acceptance or edge-case gaps. Task 55 generates the final report from test metadata and the maintained mappings; it does not retroactively invent traceability.
6. Requirements marked `SHOULD` remain planned unless an ADR records and justifies a deviation. Requirements marked `MAY` are tested when the technical specification selects or implements the option.
