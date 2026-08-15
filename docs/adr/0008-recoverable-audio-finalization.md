# ADR-0008: Recover audio finalization through prepare, reconcile, and confirm

- Status: Accepted
- Date: 2026-08-15
- Deciders: Project maintainers
- Requirements: DATA-020, DATA-021, CAP-002, CAP-003, CAP-004, STT-001

## Context

PostgreSQL and blob storage cannot participate in one atomic commit. Finalizing
the blob before recording database intent can create an object with no durable
owner. Marking a recording durable before finalizing the blob can expose audio
that does not exist. A distributed transaction would couple the application to
storage-specific machinery and is not available for the local filesystem.

The protocol must preserve an arbitrarily long recording without assembling it
in memory, make ambiguous outcomes retryable, keep original audio immutable,
reject conflicting retries, and permit conservative cleanup of genuine orphan
objects. The executable proof is in `spikes/audio-finalization`.

## Decision

Audio finalization is a three-step state machine:

1. **Prepare in PostgreSQL.** Lock the upload row; validate a versioned, ordered
   manifest against every accepted chunk; calculate its canonical fingerprint;
   and persist state `prepared`, the deterministic final blob key, expected
   byte size, final SHA-256, and manifest fingerprint in one transaction. The
   first prepared manifest is binding. An identical retry succeeds; a different
   manifest returns a stable conflict.
2. **Finalize the immutable blob.** Stream the ordered staging chunks through
   incremental chunk and final SHA-256 validation into a temporary object, then
   use the adapter's atomic create-if-absent publish operation. Never buffer the logical
   recording. If the deterministic final key already contains the expected
   size and hash, treat the operation as successful. If it contains different
   bytes, report a conflict and never replace it.
3. **Confirm in PostgreSQL.** Lock and re-read the prepared upload, compare the
   observed blob metadata with the bound manifest, and change state to
   `durable` in one transaction. Transcription work is inserted through the
   same transaction under ADR-0007. Only this committed state is durable
   confirmation to the browser and makes its local chunks eligible for cleanup.

`uploading`, `prepared`, and `durable` are durable states, not request-local
phases. One recording ID has one upload and one immutable original blob. The
recording and contribution IDs are allocated by the browser before capture and
are reused by every retry.

Each accepted chunk is keyed by `(upload_id, zero_based_index)` and stores its
byte size, SHA-256, and deterministic staging key. An identical chunk retry is
successful. A different checksum, size, key, gap, order, or manifest is a
conflict. Database constraints enforce uniqueness in addition to application
validation.

## Recovery semantics

- If preparation rolls back, no finalization is attempted. The client retries
  preparation with the same recording, upload, and manifest identities.
- If blob finalization fails, the upload remains `prepared`. A retry validates
  the same manifest and resumes finalization. Staging chunks remain referenced.
- If the blob succeeds and confirmation rolls back or its response is lost, the
  upload remains `prepared` and the expected immutable blob remains present. A
  retry recognizes its size/hash, skips replacement, and confirms it.
- If confirmation commits but its response is lost, a retry returns the already
  `durable` record. It neither rewrites the blob nor enqueues duplicate work.
- A mismatch at a staging chunk, prepared manifest, or final key is a visible
  conflict requiring investigation or a new recording/source identity. It is
  never repaired by overwriting original bytes.
- Recovery workers periodically retry old `prepared` uploads. A prepared upload
  with missing staging data becomes a visible failed/recovery-needed condition;
  it is not silently abandoned or marked durable.

This provides idempotent recovery, not atomic commitment across systems. The
database is authoritative for lifecycle and ownership; the immutable blob is
authoritative for the captured bytes.

## Orphan discovery and sweeping

Storage inventory is reconciled against both `prepared` and `durable` database
references. A final object is a candidate only when no upload references its
exact opaque key. Discovery records the key and first-seen time but does not
delete it. A later sweep, after a configurable recovery grace interval, locks
the candidate and a database advisory lock derived from the key, then rechecks
all references immediately before claiming deletion. Creation/preparation uses
the same key lock. A newly referenced object cancels its candidate.

Only a successfully claimed, still-unreferenced object may be deleted. Failed
deletes remain retryable and idempotent; successful deletion removes the
candidate and emits non-content audit/metrics metadata. The sweep never logs
audio, checksums derived from private content, or manifests.

Staging chunks follow the same conservative principle with upload-aware rules:
they are eligible only after the upload is durably confirmed and its recovery
retention has elapsed, or after an abandoned-upload retention interval with no
active/prepared reference. Inventory age alone is insufficient. Temporary
adapter files are separately eligible after the adapter's crash-recovery grace
period because they are never published blob keys.

Backups and restores can legitimately make storage and database snapshots
temporarily disagree. Therefore operators run reconciliation after restore but
must not enable destructive sweeping until restore validation is complete.

## Consequences

- The API may return a retryable finalization status while a complete immutable
  blob already exists; this is expected and safe.
- Prepared rows are operationally significant and require age/retry metrics.
- Blob adapters must support immutable conditional publication, stat, inventory,
  and idempotent deletion in addition to streaming operations. Inventory may be
  implemented by provider listing or a provider inventory feed.
- The deterministic key and checksums permit reconciliation without exposing
  provider paths or loading entire recordings into memory.
- Orphan cleanup costs two observations separated by a grace period and a final
  database check, favoring preservation over eager space recovery.

## Rejected alternatives

- Database-first durable state can expose a recording whose blob is absent.
- Blob-first finalization without prepared intent creates an avoidable orphan
  window and cannot distinguish active recovery from garbage.
- Overwriting a deterministic final key on retry violates immutable-source
  requirements and could hide a client or storage conflict.
- Deleting every unreferenced inventory object in one pass is unsafe during
  retries, concurrent preparation, and restore reconciliation.
