# Feedback and memories

Task 37 adds an explicit boundary between correcting one immutable source or
artifact occurrence and changing future processing behavior. Existing
transcript and artifact edit commands remain the only commands that change the
selected occurrence. `POST /api/v1/feedback` records feedback against an exact
owner-scoped transcript revision, artifact version, or processor result.

## Scope and approval

Feedback without a complete persistent-memory request is classified as
`occurrence_only`. A persistent command must name one compatible scope:
global transcription context, one exact processor, global known fact, or global
application preference. A mismatch fails rather than widening the rule.

`correct_and_remember` requires the literal `approved` choice. AI suggestions
are stored as visible `pending`, disabled memories and cannot affect processing
until the owner approves them. Memory types, content, rationale, revision
creator, approval state, applicable scope, and lifecycle state are stored in
immutable `memory_revision` rows. Enable, disable, approval, edit, and deletion
all append a revision; the stable memory advances with a strong ETag.

The API surface is:

- `GET /api/v1/memories` — owner-scoped, bounded search and UUIDv7 cursor page.
- `GET /api/v1/memories/{id}` — current state and up to 50 newest immutable
  revisions, with an explicit truncation flag.
- `POST /api/v1/memories/{id}/mutations` — conditional, idempotent lifecycle
  command.
- `POST /api/v1/feedback` — idempotent occurrence feedback, explicitly
  approved memory creation, or inactive AI suggestion.

Mutations require an authenticated session, same-origin CSRF, idempotency key,
and, for editable memories, the current strong ETag. Row locks and a
content-free advisory idempotency lock serialize conflicting replays. Audit
events contain only IDs, scope/state labels, counts, and hashes of non-content
metadata. Feedback and memory content never enters jobs or logs.

Deletion is an immediate soft deletion: the memory is disabled, excluded from
normal search and every new context assembly, and retained as immutable history
during the configured retention window. The UI can show deleted history
explicitly. Physical retention enforcement and exports remain in their later
owning tasks.

## Versioned transcription context

Every newly queued STT run assembles a deterministic snapshot from current
owner-approved, enabled, non-deleted global transcription memories. The
snapshot is ordered by stable memory ID, limited to 64 items and 8,000 UTF-16
code units, and stores both the stable memory ID and exact immutable
memory-revision ID. The revision ID is also the provider context version and is
part of the existing STT input fingerprint. The worker reloads this persisted
snapshot; later memory edits, disabling, or deletion cannot change a queued or
historical run.

The resulting provenance is returned by the transcript inspector as requested
or effective context. No hidden profile or arbitrary prompt string is assembled:
only visible approved memory types intended for STT are eligible.

Migration `20260823190019_solid_aaron_stack.sql` adds feedback, stable memories,
immutable memory revisions, and the owner-scoped idempotency ledger.
