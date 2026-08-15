# ADR-0009: Privacy, evidence, retention, and local backup defaults

- Status: Accepted
- Date: 2026-08-15
- Deciders: Project maintainers
- Requirements: DATA-022, PROV-001–004, NUDGE-001–007, RET-001–007,
  SEC-001–009, PORT-001–008, MODEL-006

## Context

Offline storage, evidence coordinates, provider payloads, exports, deletion, and
backups all preserve private content outside the current server response. Their
defaults must be explicit before their schemas and lifecycle workers are built.
In particular, an old browser cache or backup must not silently defeat logout or
permanent deletion, and an evidence range must mean the same thing in a browser,
an API, and an exported archive.

The initial deployment is one owner on localhost. These defaults favor privacy,
source recoverability, deterministic implementation, and honest disclosure over
convenience. They are configuration defaults, not hard-coded limits, except for
the evidence coordinate contract and anti-resurrection rules.

## Decision

### Offline cache and local unlock

Private IndexedDB records require a separate local-cache unlock secret. Enabling
offline journal caching creates a random 256-bit data-encryption key (DEK). The
browser wraps the DEK with AES-256-GCM under a key derived from the unlock secret
using Web Crypto PBKDF2-HMAC-SHA-256, a per-install 128-bit random salt, and
600,000 iterations. The unlock secret and unwrapped DEK are never persisted or
sent to the server. Each record uses a fresh 96-bit nonce and authenticated
additional data containing owner ID, record kind, stable ID, and cache schema
version.

The local unlock is distinct from the account password and passkey. It is
required after a browser process or page restart before private cached reads,
pending mutations, or pending recordings can be decrypted. Losing it permits
clearing local storage and recovering server-confirmed data, but unreconciled
local-only data cannot be recovered; setup and reset flows must state this
clearly. The service-worker app shell contains no journal content and does not
require this unlock.

Explicitly cached journal-day snapshots expire 30 days after their last
successful online refresh. They are also bounded to 200 Journal Days and a byte
budget equal to the smaller of 250 MiB or 10% of the browser-reported storage
quota; when quota cannot be estimated, the budget is 100 MiB. Least-recently
accessed snapshots are evicted first. The UI shows usage, expiry, and a clear
cache action.

Unacknowledged text mutations, recording chunks, and upload manifests are
recovery data, not read cache. They do not count against those limits and are
never expired or evicted automatically. Under quota pressure the client evicts
read cache first, stops accepting new capture if durable local writes cannot be
confirmed, and preserves already confirmed chunks.

Explicit logout clears private read snapshots, acknowledged outbox records,
service-worker API data, and all in-memory keys. Encrypted unacknowledged
mutations and recordings remain so logout cannot silently destroy unsynced
work; their presence is disclosed, and they require both a new authenticated
session for the same owner and the local unlock before replay. Session expiry or
revocation immediately locks private local data and clears in-memory keys but
does not erase ciphertext. A different owner can never adopt or decrypt it.

### Evidence coordinates and normalized text

Text evidence always targets an exact immutable source-revision ID and that
revision's canonical `evidence_text`. Canonical evidence text is produced by:

1. requiring well-formed Unicode scalar input;
2. replacing CRLF and lone CR line endings with LF; and
3. applying Unicode NFC normalization.

No other whitespace, punctuation, case, or compatibility normalization occurs.
Exact submitted typed text and exact provider raw responses remain separately
preserved; normalization never rewrites them. Normalized transcript revisions
may use their text directly as `evidence_text`.

Text spans are zero-based, end-exclusive UTF-16 code-unit offsets named
`start_utf16` and `end_utf16`. This matches JavaScript `String.prototype.slice`.
A valid span satisfies `0 <= start < end <= evidence_text.length`, and neither
boundary may split a surrogate pair. Empty evidence spans are invalid. Every
span stores the exact normalized quote and its SHA-256 in addition to the
offsets so corruption or contract drift is detectable. APIs and exports declare
`normalization: "NFC_LF_V1"` and `offset_unit: "utf16_code_unit"`; consumers must
not infer grapheme, Unicode-scalar, byte, token, or line/column offsets.

Audio evidence, when available from the provider, uses zero-based,
end-exclusive integer milliseconds named `start_ms` and `end_ms` against the
immutable original recording. Text and audio coordinates may coexist but are
independently optional. Unsupported timing is represented explicitly, never
fabricated. Evidence whose quote/hash or target revision no longer resolves is
retained and marked unresolved or stale rather than silently rebound.

### Provider raw responses

Raw provider response bodies are retained for 30 days by default. They are
immutable while retained. Expiry is an explicit configured retention action:
the payload is permanently removed, while its stable ID, provider/model and
configuration provenance, creation/deletion times, retention reason, and
content hash remain. Normalized outputs and all source/transcript revisions have
their own retention lifecycles and are not removed merely because a provider
payload expires. The owner may select `do_not_retain`, 30 days, 90 days, one
year, or indefinite retention per provider/capability; exact raw STT is retained
under the selected policy as required by DATA-022.

Human-readable and standard machine-readable exports exclude provider raw
responses by default. A complete export offers a separate, unchecked opt-in to
include each still-retained raw-response class and warns that payloads may
contain duplicated journal content and provider metadata. Credentials and
secret-bearing headers are stripped before persistence and can never be
exported.

### Consistent exports during edits and deletion

Starting an export creates a point-in-time manifest from a PostgreSQL
`REPEATABLE READ` snapshot. The manifest records the snapshot time, exact stable
and revision/version IDs, deletion state, and immutable blob keys/checksums.
Later edits create revisions and do not change that export. Changes committed
before the snapshot are reflected; changes committed after it are not.

The snapshot transaction materializes the manifest and durable blob-retention
leases before the worker streams data. Permanent deletion takes the
corresponding exclusion lock and cannot remove a leased object. Soft deletion
or a permanent-deletion request after the snapshot invalidates any in-progress
or system-hosted completed export containing the target: the job is cancelled,
partial and downloadable archives are removed, and the user may create a new
snapshot. This makes deletion win over delivery while avoiding a mixed-time
archive. Downloadable exports expire after 24 hours by default. Copies already
downloaded are outside system control, which the deletion UI must disclose.

### Deletion, tombstones, and restore

Material deletion has a 30-day recoverable grace period by default. Soft-deleted
material is immediately excluded from normal reads, processing, search, caches,
and new exports. Restoration during grace preserves its stable IDs and history.
Audio-only deletion follows the same grace independently of transcript and
journal retention. Original audio otherwise remains indefinitely by default.

Permanent deletion writes an owner-scoped, content-free tombstone before
removing material. A tombstone contains entity kind, stable ID, deletion time,
deletion generation, and audit correlation ID, but no journal text, filenames,
provider payload, content checksum, or other derived content. Stable IDs are
never reused. Imports and restores check tombstones before inserting data and
must not silently remap or reactivate a tombstoned ID.

Tombstones are append-only and retained indefinitely because they are small and
are the authority that prevents an older snapshot from resurrecting deleted
material. The primary tombstone ledger is durably committed before content is
removed. When a backup repository is configured, permanent deletion is not
reported complete until a tombstone checkpoint has also been committed there;
without one, completion carries an explicit warning that no post-deletion
restore point exists. Restore first loads the newest tombstone checkpoint
available in that repository, restores the selected snapshot into an empty
target, reapplies the tombstone ledger, removes matching content and derived
indexes, and only then opens the application. Restoring from media that predates
both a deletion and its checkpoint cannot know about that later event and must
be disclosed as such; it is not an acceptable source for a verified
post-deletion restore.

### Nudge and processor defaults

All built-in processors—food, mood, sleep, tasks/intentions, summary, and
accomplishments—are installed but disabled by default. Enabling any processor
requires showing which configured provider receives which input scope. A newly
enabled processor is optional by default; the owner must separately mark it
required before it can produce missing-information nudges.

Nudges are consolidated into at most one digest notification per local calendar
day. Default quiet hours are 21:00 through 08:00 in the owner's configured IANA
timezone; queued notifications wait until quiet hours end. In-app requirement
state remains visible during quiet hours. A dismissal applies to that Journal
Day and prevents another default digest for it. These limits and hours are
configurable, but processor failure can never consume a nudge allowance or be
reported as missing user information.

### Local backup and encryption

The supported local backup technology is `restic` with a repository in a
configured directory outside the live PostgreSQL and blob-data directories.
First-run backup setup generates a random 256-bit restic repository password,
stores it in a separate owner-only (`0600`) secret file, initializes the
encrypted repository, and never writes the password into an archive, log, or
export. Backup staging directories and repository files are owner-only. A
second device or filesystem is strongly recommended because encryption on the
same disk does not provide disaster recovery.

Each backup uses one coordinated manifest and PostgreSQL snapshot, a
`pg_dump --format=custom` dump including application and `pgboss` schemas, the
exact immutable blob set protected by retention leases, configuration metadata
without secrets, the tombstone checkpoint, and SHA-256 checksums. Files are
streamed or staged with bounded memory. A backup is successful only after
`restic check` can read the snapshot metadata and application validation matches
the manifest; leases are then released.

The default schedule is once daily when the host is available. The default
restic policy is 7 daily, 5 weekly, and 12 monthly snapshots, followed by
`forget` and `prune`; therefore permanently deleted content may remain encrypted
in retained backup snapshots for up to approximately one year. The deletion UI
discloses this. An explicit emergency purge discards affected historical
snapshots, creates and validates a clean backup plus tombstone checkpoint, and
prunes unreferenced repository data, trading away older recovery points. Restore
drills run at least quarterly and after backup-tool or schema changes.

## Consequences

- Offline access has a deliberate extra unlock step and local-only work depends
  on retaining that secret, but a stolen browser profile does not expose journal
  text directly.
- Cache eviction can never be used to reclaim recovery data. Capture must stop
  visibly before quota exhaustion would make new chunks unsafe.
- Evidence adapters must produce one canonical projection and validate UTF-16
  boundaries; other offset units require an explicit future schema version.
- Raw-response pruning reduces privacy exposure while retaining useful
  provenance and normalized artifacts.
- Export generation needs immutable manifests, retention leases, cancellation,
  and deletion-aware cleanup rather than a long-running live query.
- Tombstones intentionally outlive journal content. Verified restore depends on
  the newest tombstone checkpoint, not just the chosen data snapshot.
- Backups are encrypted but their default history delays physical erasure; the
  faster purge path explicitly sacrifices recovery history.

## Rejected alternatives

- Unencrypted IndexedDB or an unlock token persisted beside ciphertext offers
  little protection after device/profile compromise.
- Automatically evicting pending recordings or mutations violates recoverable
  capture and offline durability.
- Unicode-scalar, byte, grapheme, or inclusive offsets do not match browser
  string slicing and invite cross-runtime ambiguity.
- Exporting from live current pointers can mix revisions and deletion states in
  one archive.
- Restoring an old database before applying later tombstones can resurrect data
  the owner permanently deleted.
- Unencrypted tar archives and backups inside the live data directory do not
  meet the privacy or failure-independence goals.
