# Retention and permanent deletion

This document is the operational contract for RET-001–RET-007. Material and
audio deletion use independent owner-scoped policies and a 30-day recoverable
grace period by default. Original audio otherwise defaults to indefinite
retention. Raw provider responses default to 30 days.

## Deletion matrix

| Surface | Contribution or Journal Day | Recording audio only | Provider raw response |
| --- | --- | --- | --- |
| PostgreSQL source and revision rows | Delete the source graph and immutable revisions. | Retain duration, size, MIME/codec, checksum, capture time, persistence state, and deletion time; the recording stays non-playable. | Clear the response ID, object key, media type, byte size, checksum, provider request ID, policy, and expiry from the provenance run; retain the run itself. |
| Final objects | Delete audio and every provider-response object in the affected dependency graph. | Delete the original-audio object. | Delete the raw-response object. |
| Staging objects and rows | Delete every captured chunk object and row. | Delete every captured chunk object and row. | Unrelated staging data is retained. |
| Browser read cache | Clear the owner's encrypted journal snapshots conservatively. | Clear cached responses and the matching local recording/chunks. | No raw provider response is stored in the browser. |
| Browser outbox | Remove mutations whose stable identity is tombstoned; preserve unrelated recovery work. | Remove matching recording recovery work. | Unrelated outbox work is retained. |
| Lexical text and vectors | Delete affected fragments; embedding rows cascade. Transitive processor artifacts and grounded answers that cite affected fragments are also deleted. | Retain transcript and journal search because audio-only deletion deliberately retains transcripts. | Search material is unaffected. |
| System-hosted exports | A tombstone is the exclusion authority. An export adapter must cancel and remove any in-progress or hosted archive that contains a newly tombstoned target. | Invalidate an archive containing the audio; a replacement may still contain the retained transcript. | Invalidate an archive containing the raw response. |
| Downloaded exports | Outside system control; every preview warns the owner. | Same. | Same. |
| Backups | Retain encrypted historical snapshots until repository expiry, but restore must load the newest tombstone checkpoint and reapply it before opening the application. | Same; the checkpoint prevents audio resurrection. | Same; the checkpoint prevents response resurrection. |
| Audit | Delete older target/derived audit rows that carry content hashes or linked mutable metadata. Retain minimal request/completion events containing kind, generation, checkpoint state, actor, correlation, and time only. | Same. | Same. |
| Tombstone | Retain forever, append-only, with owner, kind, stable ID, deletion time, generation, and correlation ID only. | Same. | Same. |

Tasks 48 and 49 add the export and backup repositories. Until those adapters
exist, deletion completes live storage with `backupCheckpoint =
not_configured` and an explicit warning that no verified post-deletion restore
point exists. Those adapters must consume this ledger and may not weaken its
ordering rules.

## Ordering, bounds, and recovery

1. The authenticated owner requests a scoped impact preview. The API requires
   the exact `PERMANENTLY DELETE` confirmation and rejects material still in
   grace.
2. One PostgreSQL transaction locks the owner's policy generation, commits the
   primary and child tombstones, records the durable purge request, captures
   object keys, and appends the minimal requested audit event. Queue payloads
   contain only the request ID. A failed queue send is recoverable because the
   daily scanner claims the durable request.
3. Workers claim at most 100 requests per scheduled execution with `SKIP
   LOCKED`. Object keys are read 128 at a time. A missing object is an
   idempotent success; another storage error marks the request retryable and
   leaves SQL material intact. A purging lease older than 15 minutes can be
   reclaimed after a worker crash.
4. Only after all object rows are marked deleted does one PostgreSQL
   transaction purge the source graph, revisions, transitive processor data,
   text/vector indexes, grounded answers, feedback, and content-bearing audit
   history. It removes temporary object-key rows and commits the completion
   event atomically.
5. Before replaying offline work, every browser drains the owner-scoped
   tombstone ledger page by page. IndexedDB cache/outbox/recording cleanup is
   transactional per page. Service-worker caches are removed, the applied
   generation is persisted, and only then is the final generation
   acknowledged. Replay cannot run between pages.

The request and every destructive query are owner-scoped. Tombstones never
contain journal text, filenames, object keys, provider payloads, or content
checksums. They are the permanent negative authority: normal create and restore
paths reject tombstoned Journal Day, contribution, and recording identities.
Backup/import implementations must do the same, must restore into an empty
target, and must reapply the newest available tombstone checkpoint before any
read or worker is enabled. Media that predates both a deletion and its
checkpoint cannot be described as a verified post-deletion restore source.
