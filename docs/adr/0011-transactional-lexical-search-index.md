# ADR-0011: Maintain a current-revision PostgreSQL lexical index transactionally

- Status: Accepted
- Date: 2026-08-25
- Deciders: Project maintainers
- Requirements: SEARCH-001, SEARCH-003, SEARCH-005, SEARCH-006, RET-007

## Context

Lexical retrieval must cover exact immutable source revisions while returning
only the current, owner-visible view. Contribution edits, transcript correction,
processor reconciliation, manual artifact authority, memory approval, staleness,
and soft deletion can all change that view. An asynchronous indexer would leave
a window in which replaced or deleted private text remained retrievable.

PostgreSQL is already authoritative for all of these lifecycle transitions and
provides full-text indexes. Task 45 will add optional vector cohorts, but lexical
search must not depend on an AI provider or worker.

## Decision

`journal.search_fragment` is a derived, independently addressable current-view
index. Every row retains its stable source identity, exact immutable revision
identity and number, Journal Day, source/result layer, authority, contribution
type, and processor/version where applicable. Plain content is indexed by an
English generated `tsvector` with a GIN index.

Database triggers refresh fragments in the same transaction that advances or
invalidates canonical state. They index current typed/nudge revisions, selected
current transcript layers, effective active artifact authority, and enabled,
approved current memories. They delete replaced, stale, disabled, superseded,
or soft-deleted material immediately. Query paths remain owner-scoped and use
only this current-view table; immutable source history remains in canonical
tables for audit and exact navigation. The migration backfills existing current
material through the same refresh functions.

Quoted input uses PostgreSQL phrase parsing. Unquoted normalized lexemes use
prefix matching. Ranking uses `ts_rank_cd`; ties are ordered by Journal Day
descending and fragment UUID ascending. The opaque cursor stores this tuple and
a fingerprint of the query and filters, preventing reuse under different
criteria. All filters compose in SQL before ranking and pagination.

PostgreSQL produces snippets with private sentinel characters after stripping
those sentinels from canonical text. The API converts markers into arrays of
plain text/highlight flags. The UI interpolates those strings and never accepts
or renders search-result HTML.

## Consequences

- Deletion and staleness visibility are atomic with canonical writes; no worker
  availability is required for privacy correctness.
- Index rows are rebuildable and do not replace immutable source history.
- Trigger coverage is part of migration compatibility testing and must be
  updated when a later task introduces another searchable lifecycle.
- Task 45 may add embedding columns/cohorts or a sibling index, but it must keep
  the same owner, revision, authority, and lifecycle exclusion semantics.
