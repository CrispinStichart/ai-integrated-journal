# ADR-0010: Bound resources per operation, not per recording

- Status: Accepted
- Date: 2026-08-15
- Deciders: Project maintainers
- Requirements: CAP-002, CAP-003, CAP-005, CAP-006, STATE-006,
  PORT-001, PORT-003, PORT-004

## Context

The product permits recordings of any duration and final byte size. That does
not make browser quota, host disk, process memory, network requests, or provider
capabilities unlimited. Treating a final recording as one browser `Blob`, JSON
manifest, request body, server buffer, or export member would turn one of those
finite resources into an undocumented recording limit and could discard a long
capture late in its lifecycle.

The application must distinguish an application-imposed limit from exhaustion
of a real deployment resource. It must also fail at a checkpoint boundary:
already committed local or server chunks remain recoverable even when the next
write, finalization copy, export, or backup cannot proceed.

## Decision

### Meaning of no maximum

There is no validation rule, schema constraint, timer, aggregate byte counter,
or UI behavior that rejects a recording because its total duration, total byte
size, or number of chunks exceeds an application maximum. Counters use
overflow-safe integer representations and APIs paginate any collection whose
size grows with the recording.

Finite storage exhaustion may stop capture or defer an operation. That is a
visible resource failure, not a recording-length policy. Freeing or adding
storage and retrying must not require discarding the persisted prefix.

Defaults in this ADR are versioned configuration except the invariant that a
logical recording is never assembled in memory. Operators may reduce a
per-operation bound, but may not configure an aggregate recording cap.

### Capture and transport units

- `MediaRecorder` requests a 5-second timeslice. A timeslice is a checkpoint
  cadence, not a guaranteed byte boundary: each emitted browser-managed `Blob`
  is traversed into bounded recovery units, and each unit is committed to
  IndexedDB before it becomes eligible for upload.
- Upload transport units contain at most 8 MiB of audio. A larger emitted
  `Blob` is traversed with non-materializing `Blob.slice()` views and
  committed/uploaded as indexed transport units; application code never calls
  `arrayBuffer()` or creates a concatenated `Blob` for the complete recording.
- An audio upload request body is limited to 8 MiB. Metadata request bodies are
  limited to 256 KiB. A declared oversize body is rejected before reading it;
  a chunked body is stopped by a streaming byte counter. The incomplete
  temporary unit is removed and all previously committed units remain.
- The browser uploads at most one unit per recording and two units globally at
  a time. The API streams each body through incremental SHA-256 calculation to
  staging storage with backpressure. Retries retain the identity, index, size,
  and checksum rules in ADR-0008.
- Audio reads use HTTP byte ranges capped at 8 MiB per response. Playback and
  export consumers request or stream successive ranges; they never use a
  whole-recording response as an in-memory fallback.

These defaults may be changed only as one coherent protocol version: advertised
client and server limits must agree, and reducing a limit cannot make already
staged units unreadable or unfinalizable.

### Incremental manifest

The accepted chunk rows are the server-side ordered manifest. Each successful
chunk request adds one bounded descriptor. The client computes the canonical
manifest digest by walking an IndexedDB cursor; the server computes the same
digest by cursor-paginating ordered rows. Neither side materializes all
descriptors at once.

The finalize request is a bounded summary containing the manifest version,
chunk count, total bytes, and manifest SHA-256. In ADR-0008, “submit the ordered
manifest” and “validate a manifest” mean submitting this summary and validating
it against the incrementally persisted ordered manifest. Chunk count and byte
count are decimal strings on the wire so JavaScript safe-integer limits do not
become aggregate recording limits. The first successfully prepared summary
remains binding under ADR-0008.

### Browser quota policy

Pending recording data is recovery data under ADR-0009 and is never evicted to
make room. The client:

1. requests persistent browser storage when recoverable capture is enabled;
2. calls `navigator.storage.estimate()` before capture, after each committed
   unit, and when the document becomes visible again;
3. first evicts eligible read-cache data at the low-space threshold; and
4. treats successful completion of the IndexedDB transaction as the only proof
   that a unit is locally saved.

The default low-space threshold is remaining estimated quota at or below the
greater of 128 MiB or 10 percent of reported quota. The safety reserve is 32
MiB. At low space, the recording status announces the condition and shows
estimated remaining bytes without claiming an exact remaining duration. If an
estimate says the next 8 MiB transport unit plus the reserve cannot fit, the
client stops accepting further capture before the next checkpoint.

Storage estimates are advisory and may be absent or stale. If estimation is
unavailable, capture may proceed while the UI says availability is unknown. An
IndexedDB `QuotaExceededError`, transaction abort, or failed read-back stops the
recorder immediately and creates a persistent `browser_storage_exhausted`
state. The UI uses an assertive live announcement, identifies the last
successfully saved checkpoint, and offers retry/upload/export of the preserved
prefix after space is available. It never labels the failed unit locally saved
or silently starts a replacement recording. Browser eviction of recovery data
is reported as corruption/recovery-needed, not accepted as normal cleanup.

### Server and host disk policy

Every writable location has a capacity probe: local blob staging/final/temp
storage, export staging, backup staging/repository, and the PostgreSQL volume.
For the initial local deployment, the owning process or container probes the
filesystem that actually backs each path. A storage adapter that cannot report
capacity returns `unknown`; readiness is then degraded and the operations UI
states that proactive protection is unavailable. Unknown capacity never
permits a false “space available” status.

The default low watermark is the greater of 1 GiB or 10 percent of filesystem
capacity. The default critical reserve is the greater of 256 MiB or 2 percent.
Thresholds are configurable per location, validated as non-negative and ordered
(`critical < low`), and exposed in authenticated health details.

Before accepting a unit, the server requires enough reported free space for the
declared unit, temporary-write overhead, and the critical reserve. Before
finalization, export, backup, restore, or other materialization, it budgets the
known output plus temporary-copy overhead and the reserve. Long-running writes
recheck at every unit and at least every 30 seconds. A backend that supports a
more reliable reservation primitive may use it, but the same visible behavior
is required.

Crossing the low watermark emits a content-free operational warning. Failing
admission or a write because capacity is critical returns RFC 9457 problem
details with `server_storage_exhausted` and HTTP `507 Insufficient Storage`.
The current unpublished temporary output is cleaned up; accepted staging chunks
and prepared uploads are retained. A database write or durable confirmation
that fails for lack of space is not acknowledged, so the browser retains its
local recovery copy. No cleanup job may delete active or recovery-retained data
to satisfy a write.

Local finalization may temporarily require the complete final byte size in
addition to staging data. Its preflight reports that requirement and leaves the
upload prepared if insufficient space exists. This physical requirement is not
converted into a configured recording cap.

### Bounded-memory pipelines

Capture, upload, checksum calculation, finalization, playback, transcription
handoff, export, backup, restore, and integrity verification operate over
`Blob` slices, cursors, async iterables, streams, or bounded temporary files with
backpressure. A provider adapter that requires a complete seekable file may use
an owner-only temporary file; it may not buffer the recording in process memory.
Provider duration/size limits fail only that optional run, remain visible as a
capability error, and never prevent source durability, playback, export, or a
retry with another provider.

Generated archive formats may have per-entry or total-size format limits.
Export and backup implementations must select ZIP64 or another documented
streamable format whose relevant limits exceed the underlying platform, and
must fail explicitly rather than truncate or omit audio.

Memory use is bounded by configured concurrency and per-unit stream buffers,
not by logical recording size. All stream producers honor backpressure and all
abort/error paths close handles and remove only their unpublished temporary
output.

### Status, observability, and verification

`browser_storage_low`, `browser_storage_exhausted`, `server_storage_low`, and
`server_storage_exhausted` are distinct from network, checksum, and provider
failures. Status includes the affected stage, whether retry is safe, and
content-free capacity figures when known. Logs and metrics may contain unit
counts, byte counts, free-space bands, duration, stage, and error code; they do
not contain audio, manifests, checksums, journal identifiers, or storage keys.

The audio milestone must verify:

- an implementation-generated recording much larger than every transport unit
  completes while peak process memory remains flat within a documented
  tolerance;
- upload, finalization, ranged playback, export, backup, and restore use
  incremental I/O and do not invoke whole-recording buffer APIs;
- quota failure on unit N preserves units `0..N-1`, reports the exact last
  committed checkpoint, and resumes without duplicate identities;
- server exhaustion during upload and finalization preserves accepted staging
  data and permits retry after capacity returns;
- oversized and streaming-overrun requests fail without publishing a partial
  unit; and
- physical Firefox Mobile checks cover long capture, advisory quota reporting,
  actual quota failure where the test environment permits it, backgrounding,
  and recovery.

Tests use synthetic generated bytes and content-free fixtures and include the
applicable requirement IDs in their names.

## Consequences

- A recording can continue until a real storage resource is exhausted, while
  each allocation, request, query page, and memory buffer remains bounded.
- The UI may stop before the browser's reported quota reaches zero to preserve
  a write safety margin. It explains the resource condition and retains the
  successfully checkpointed prefix.
- Local finalization can need substantial additional disk. Streaming solves
  memory growth, not finite storage capacity.
- Finalization requires an incremental canonical digest contract rather than a
  variable-size JSON manifest.
- Storage-capacity probes and pressure tests are adapter and deployment
  responsibilities, not local-filesystem assumptions in domain code.

## Rejected alternatives

- A generous fixed duration or final-size limit still violates the product
  contract and merely postpones failure.
- Keeping all `MediaRecorder` output in component memory makes navigation,
  suspension, and late interruption destructive.
- Sending one whole recording or one complete chunk list in a request moves the
  aggregate limit into HTTP parsing and process memory.
- Evicting unconfirmed capture under pressure trades a visible resource error
  for silent source loss.
- Continuing after an uncommitted IndexedDB write creates a gap while implying
  the recording is recoverable.
- Loading a complete file for hashing, playback, provider upload, export, or
  backup violates the same invariant at a later stage.
