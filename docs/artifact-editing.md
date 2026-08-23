# Manual artifact editing

Task 35 adds the manual-authority layer over the immutable generated artifacts from Tasks 32–34. A stable artifact has a monotonic edit revision used in strong ETags, append-only generated versions, append-only manual overlay revisions, and at most one reviewable generated conflict candidate.

## Authority and effective values

A correction stores bounded JSON Pointer overrides plus the complete effective payload at edit time. Readers apply the active paths over the latest generated payload, so generated changes to unrelated fields remain visible while every addressed manual field wins. Confirmation, deletion, split sources/results, and merge sources/results are whole-artifact overrides. Deletion is a manual tombstone rather than physical removal.

Reconciliation continues to store the exact generated processor result. When its candidate differs from an active manual revision, it does not update the effective value: it appends a candidate linked to the exact manual revision. Only explicit adoption creates a new manual confirmation revision. Dismissal resolves the candidate without changing the effective payload. Releasing an override is also explicit and restores the active generated version when one exists.

Split and merge execute atomically. Source artifacts receive manual tombstone revisions and results receive new stable manual identities using the reserved `manual:` logical-key namespace. Every prior payload, supersession relationship, generated proposal, and user action remains auditable.

## HTTP and privacy boundary

- `GET /api/v1/journal-days/:id/artifacts` returns owner-scoped effective views, review candidates, and immutable history.
- `POST /api/v1/artifacts/:id/edits` supports correct, confirm, delete, split, candidate adoption/dismissal, and override release.
- `POST /api/v1/artifacts/merge` requires an ETag containing every source revision and applies all changes in one transaction.

Mutations require an authenticated session, same-origin CSRF validation when session auth is configured, an idempotency key, and a strong artifact ETag. PostgreSQL row locks and uniqueness constraints serialize conflicting edits. Audit events contain identifiers, actions, counts, and hashes only; payloads, journal text, reasons, prompts, and provider output never enter logs or audit metadata.

The Journal Day review panel exposes manual/generated labels in text, candidate comparisons, immutable history, correction, confirmation, split, merge, deletion warnings, and override release. All actions remain usable without an AI provider or worker.
