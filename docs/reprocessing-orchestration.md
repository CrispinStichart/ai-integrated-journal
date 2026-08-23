# Reprocessing orchestration

Historical reprocessing is a preview-and-confirm workflow. It supports one
contribution, one Journal Day, a date range, one processor across a date range,
or one immutable processor version across a date range (EDIT-003–EDIT-004).

## Safety and reproducibility

- Date ranges are inclusive and limited to 366 calendar days. A confirmed
  batch is limited to 10,000 processor runs and 64 selected versions.
- A preview resolves `current` selections to immutable processor-version IDs.
  A `pinned` selection uses only the supplied immutable IDs. The resolved basis
  is stored on the batch and displayed with every historical record; “current”
  never becomes a floating interpretation of completed work (EDIT-008).
- Previewing is read-only. It reports affected Journal Days and contributions,
  stale results, active manual overrides, exact versions, planned runs, and an
  approximate provider-operation count. Deterministic runs count as zero;
  structured-generation and embedding capabilities each count as one provider
  operation per run.
- Confirmation repeats canonical target resolution inside the write
  transaction. It rejects a changed impact fingerprint, so contributions,
  processor pointers, or other inputs cannot change silently between preview
  and scheduling.
- The batch, its exact target/version membership, new immutable run attempts,
  identifier-only pg-boss jobs, idempotency result, and content-free audit event
  commit in one PostgreSQL transaction (ADR-0007). A rollback leaves none of
  them visible.
- Existing processor input assembly binds exact contribution, transcript, and
  upstream-result revisions. Reconciliation retains generated history and
  applies ADR-0004, so active manual revisions and tombstones remain
  authoritative while disagreements become reviewable candidates
  (EDIT-005–EDIT-007).

## Progress, cancellation, and history

`GET /api/v1/reprocessing-batches/{id}` derives progress from canonical run
rows. Batch history uses deterministic, bounded cursor pagination. The Activity
view polls every three seconds while open, with an explicit refresh control.
This avoids treating an in-memory event notification as durable state; future
SSE events can trigger the same canonical refetch.

Cancellation requires authentication, CSRF, an idempotency key, and the current
batch ETag. In one transaction it marks the batch canceled and changes only its
queued or running runs to `canceled`. Already completed results remain in
history. Workers reload canonical state before provider work, and a worker that
races with cancellation cannot complete a canceled run. Queue records may
remain until consumed, when they no-op, and then expire under the bounded queue
retention policy.

Audit events contain IDs, counts, scope names, hashes, and version counts only.
They never contain journal text, prompts, response payloads, or manual values.

## API summary

- `POST /api/v1/processing-runs/reprocessing/preview`
- `POST /api/v1/reprocessing-batches`
- `GET /api/v1/reprocessing-batches`
- `GET /api/v1/reprocessing-batches/{id}`
- `POST /api/v1/reprocessing-batches/{id}/cancel`

Preview and mutation requests require an online authenticated session. No AI
processing is attempted offline.
