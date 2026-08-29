# Portable export format

Task 48 implements the portability requirements PORT-003–PORT-008 and acceptance criteria AC-050–AC-052.

## Snapshot and lifecycle

`POST /api/v1/exports` requires an `Idempotency-Key` and opens a PostgreSQL `REPEATABLE READ` transaction. Before PostgreSQL establishes that snapshot, the transaction acquires the export/deletion exclusion fence; deletion transactions take the conflicting side of the same fence. In the transaction the application creates an export request, copies every selected database row into immutable `export_snapshot_item` JSONB records, creates retention leases for selected immutable blobs, and inserts the identifier-only `pg-boss` job. A failure in any part rolls all of them back. Replaying a key with the same selections returns the original export; reusing it with different selections fails with a conflict. Each copied record has:

- `entityType`, identifying the documented JSON Lines collection;
- `stableId`, identifying the logical entity or relationship;
- `versionId`, identifying the exact immutable revision/version when applicable;
- `journalDate`, when the record belongs to a Journal Day; and
- `data`, containing the point-in-time database record without renaming its fields or collapsing semantic values.

Edits committed after `snapshotAt` are not visible in that export. Soft-deleted source material is excluded. Soft deletion or permanent deletion invalidates any queued, running, or hosted completed export containing the target and releases its leases; scheduled cleanup removes an invalidated hosted archive. Downloadable archives expire after 24 hours; scheduled retention closes the download before deleting the hosted blob and retries interrupted cleanup safely. Successful archive-open attempts are recorded as content-free audit events. Copies already downloaded are outside application control.

## ZIP layout

Archives use ZIP64 and are created with bounded stream buffers. Audio and raw provider bodies are never assembled in memory.

```text
manifest.json
manifest.sha256
data/<entity-type>.jsonl
journal/<YYYY-MM-DD>.md
audio/<recording-id>/original.<media-extension>       # selected only
provider-raw/<raw-response-id>.json                  # selected only
```

`manifest.json` uses `archiveFormat: "journal-portable-export"` and `manifestSchemaVersion: 1`. It records the snapshot/export timestamps, content selections, evidence-coordinate contract, supported semantic and authority states, stable relationship convention, entity counts, and the SHA-256 and canonical decimal-string byte size of every preceding archive entry. Decimal strings preserve sizes throughout the PostgreSQL `bigint` range without JavaScript rounding. `manifest.sha256` contains the SHA-256 of the exact `manifest.json` bytes. The API also returns the SHA-256 of the complete ZIP in `X-Content-SHA256`.

To verify the manifest on a Unix-like host after extraction:

```sh
sha256sum --check manifest.sha256
```

Consumers should additionally hash each file listed by `manifest.json` and compare its byte size and checksum.

## Machine-readable collections

The `data` directory contains one JSON object per line. It includes owner-visible journal days; contributions and all retained revisions; recordings; transcription, transcript, segment, cleanup, and evidence history; processor definitions, immutable versions, dependencies, runs, inputs, results, evidence, artifacts, generated versions, manual revisions, candidates, and reconciliation history; memories and revisions; feedback; nudge state; grounded answers and citations; reprocessing history; audit events; and retention policies, deletion requests, and tombstones.

Database field names are retained in `data`. PostgreSQL emits the stored JSON text directly into JSON Lines, so integer tokens larger than JavaScript's safe-number range are not rounded during export. Consequently semantic values such as `{ "state": "unknown" }`, `{ "state": "neutral" }`, and `{ "state": "none" }` remain distinct. Manual/generated authority, manual resolution, staleness, supersession, provider/model/configuration snapshots, prompt and instruction hashes, input fingerprints, processing times, evidence coordinates, raw-response retention state, and deletion timestamps remain explicit.

Provider-specific raw bodies are excluded by default. The separate opt-in includes only bodies still retained and not tombstoned when the snapshot is created. Secret headers and credentials are never persisted or exported. Switching the configured provider does not mutate historical run snapshots or source records; earlier provider/model provenance therefore remains readable in its original JSONL record.

## Human-readable Journal Days

Each `journal/<date>.md` presents retained contribution revisions, transcript revisions, and artifact versions for that Journal Day. It labels stable identities, immutable revisions, authority, and lifecycle state. Markdown is a convenience view; JSON Lines and the manifest remain the complete portability representation.
