# Reliability and fault testing

Task 52 exercises recovery at the capability, queue, database, browser, export,
and restore boundaries. The tests use synthetic content and deterministic fault
injection. They never require a paid provider, intentionally fill the host
filesystem, or place journal content in a queue, error, log, or metric.

## Fault model and invariants

Provider adapters can be wrapped with
`createFaultInjectingAiProviderFactory`. Its per-capability script fails exact
invocation numbers with `AiProviderOperationError`, then delegates normally.
The error exposes only a stable code, retryability, and an optional retry delay;
its message is deliberately content-free. Transcription, cleanup, processor,
embedding, and grounded-answer workers persist that stable code and classify
rate limits, timeouts, and outages as retryable while authentication and invalid
requests remain permanent. Existing queue backoff and dead-letter policy remains
the retry authority; the provider retry-delay hint is available at the adapter
boundary but is not persisted and does not override configured pg-boss policy.

Every fault scenario asserts the applicable safety properties:

- canonical source text/audio remains available and immutable;
- a retry reloads canonical state and retains the same stable identity;
- duplicate delivery cannot duplicate source mutations, jobs, reconciliations,
  active artifacts, or exports;
- stale and deleted data cannot become current through retry, export, or restore;
- faults persist content-free codes rather than prompts, questions, source text,
  provider bodies, credentials, or object keys; and
- recovery is bounded per operation and repeatable.

## Automated fault matrix

| Fault domain | Behavioral evidence | Expected recovery |
| --- | --- | --- |
| Provider outage and rate limit | `packages/test-support/test/fake-ai.test.ts`, `apps/worker/test/transcription-pipeline.integration.ts`, `apps/worker/test/processor-runtime.integration.ts`, `apps/worker/test/search-embedding.test.ts`, and `apps/worker/test/grounded-answer.test.ts` | Retryable attempts retain stable content-free failure codes and no output; a later attempt succeeds from canonical input. Permanent authentication failure dead-letters. |
| Worker crash and abandoned job | `packages/database/test/queue.integration.ts` claims a real pg-boss job, lets its lease expire, supervises the queue, and observes it return to retryable work. The same suite proves every retry reloads canonical state. | Heartbeat/expiration recovery requeues abandoned work; canonical completion turns redelivery into a no-op. |
| Missed SSE and polling | `apps/api/test/app.test.ts` verifies Last-Event-ID replay over a real HTTP stream and authenticated polling. `apps/web/test/nudge-digest-card.test.ts` withholds every SSE update and observes the 15-second query poll load the new digest revision. | SSE is a latency hint. Polling/refetch remains the correctness path when replay history or EventSource is unavailable. |
| Offline reload and synchronization | `playwright/shell.spec.ts` reloads the installed PWA, unlocks encrypted storage, creates a note offline, reconnects, and observes one durable contribution. `apps/web/test/offline-journal.test.ts` also injects a network failure, reconstructs the journal object, and replays the original UUIDs/idempotency key. | Encrypted outbox records survive reload; replay stays ordered and server idempotency prevents duplication. |
| Duplicate mutations and jobs | `apps/web/test/offline-journal.test.ts`, `packages/database/test/journal.integration.ts`, `packages/database/test/queue.integration.ts`, and `packages/database/test/processor-reconciliation.integration.ts` exercise duplicate enqueue, API replay/conflict, transactional deterministic job IDs, and concurrent duplicate reconciliation. | Same request returns the original outcome; changed reuse conflicts; duplicate jobs produce one reconciliation and one active version per stable key. |
| Long staleness chain | `apps/worker/test/processor-runtime.integration.ts` creates 32 exact result-to-result input edges, invalidates the root revision, and repeats invalidation. | All and only reachable results become stale once; repeating the fault is an idempotent no-op. |
| Concurrent whole-day reconciliation | `packages/database/test/processor-reconciliation.integration.ts` runs competing day reconciliations concurrently against PostgreSQL advisory locks and uniqueness constraints. | Both calls complete with create/update history while exactly one active artifact version remains. |
| Disk and browser storage pressure | `apps/api/test/recording-routes.test.ts` injects `ENOSPC`, verifies a content-free HTTP 507, and retries the same recording/chunk identity. `apps/web/test/capture-controller.test.ts` and `apps/web/test/offline-journal.test.ts` inject `QuotaExceededError`. | Existing checkpoints/outbox work remain intact; read cache is evicted before pending writes; capture stops visibly and may retry after capacity returns. |
| Export during editing or deletion | `packages/database/test/export.integration.ts` creates a PostgreSQL point-in-time snapshot, commits a later revision, and proves the frozen export is unchanged. It then soft/permanently deletes the source and verifies queued/completed delivery is invalidated and hosted cleanup is retryable. | An archive is internally consistent at its snapshot, while deletion always wins over delivery. |
| Restore after permanent deletion | `packages/database/test/backup-tool.test.mjs` restores an older selected snapshot with a newer contribution tombstone, verifies purge before search rebuild/job reconciliation, and observes no resurrected blob. | Restore accepts only an empty target, validates checksums, applies the newest ledger first, restores only still-live blobs, then resumes only canonically required work. |

## Commands

Focused deterministic suites:

```sh
corepack pnpm exec vitest run packages/ai/test/index.test.ts packages/test-support/test/fake-ai.test.ts apps/worker/test/search-embedding.test.ts apps/worker/test/grounded-answer.test.ts apps/web/test/nudge-digest-card.test.ts apps/web/test/offline-journal.test.ts apps/api/test/recording-routes.test.ts packages/database/test/backup-tool.test.mjs
corepack pnpm exec vitest run --config vitest.infrastructure.config.ts packages/database/test/queue.integration.ts packages/database/test/processor-reconciliation.integration.ts packages/database/test/export.integration.ts apps/worker/test/transcription-pipeline.integration.ts apps/worker/test/processor-runtime.integration.ts
```

Release gate:

```sh
corepack pnpm validate
```

## Deliberate limits

The automated disk-pressure tests inject browser and operating-system errors;
they do not consume the developer machine's real disk. The backup test executes
the complete restore orchestration with deterministic restic/pg_restore and SQL
adapters, while the quarterly drill in `backup-and-restore.md` remains the proof
for installed external binaries and physical recovery media. Physical Firefox
Mobile, accessibility, security review, and final operator evidence belong to
Tasks 53–55 and are not claimed by this task.
