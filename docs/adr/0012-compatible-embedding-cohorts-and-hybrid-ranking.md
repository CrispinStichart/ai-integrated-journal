# ADR-0012: Index semantic chunks in exact embedding cohorts and fuse ranks

- Status: Accepted
- Date: 2026-08-25
- Deciders: Project maintainers
- Requirements: ARCH-005, SEARCH-002, SEARCH-003, SEARCH-005, SEARCH-006, MODEL-001–005, SEC-007, RET-007

## Context

Semantic retrieval is optional and provider-neutral. Vectors are comparable only
when the provider, model, model version, public effective configuration, and
dimension are compatible. Journal revisions can be arbitrarily long, while
provider calls, worker memory, queue payloads, query input, and result sets must
remain bounded. Replaced, stale, disabled, superseded, or deleted source text
must disappear from both lexical and semantic retrieval immediately.

## Decision

`search_fragment` remains the lifecycle authority selected in ADR-0011. A
database trigger transactionally creates a `search_embedding_request` whenever
a current fragment appears and cascade-deletes its request and vectors when that
fragment is removed. The queue dispatcher publishes only fragment, request, and
generation identifiers. Workers reload current text from PostgreSQL and embed
at most sixteen 2,000-character chunks per attempt, continuing through a new
identifier-only job when necessary. Partial reindexes are not queryable.

`search_embedding_cohort` records the owner, provider, model, model version,
dimension, effective public configuration, and its stable fingerprint.
`search_fragment_embedding` stores independently ranked chunks against the
exact source revision. Owner-consistency foreign keys and owner predicates
prevent cross-owner cohort or vector references. HNSW expression indexes cover
the deterministic four-dimensional fixture and common 384, 768, 1024, 1536,
and 3072 dimensional cohorts; 3072 dimensions use pgvector `halfvec` because a
`vector` HNSW index is limited to 2,000 dimensions. Other valid dimensions use
exact scan until an operator index is deliberately added.

A semantic query is embedded with the same configuration and compares vectors
only inside the exact provider/model/version/configuration/dimension cohort.
The best chunk represents each exact revision. Hybrid retrieval gets bounded
lexical and semantic candidate lists and applies reciprocal-rank fusion with
`k = 60`; ties are Journal Day descending and fragment UUID ascending. Opaque
cursors include the requested mode and complete query/filter fingerprint.

If embeddings are disabled, unavailable, invalid, failing, or not yet indexed
for the selected cohort, semantic and hybrid requests return deterministic
lexical results with an explicit fallback reason. Source capture, viewing,
editing, and lexical search never depend on a provider or worker.

## Consequences

- Provider changes do not mutate canonical sources or compare incompatible
  vectors; an owner reindex advances a generation while preserving prior cohort
  provenance.
- Very long revisions require multiple bounded jobs but never a content-bearing
  queue payload or one unbounded provider request.
- Search responses expose retrieval method and cohort metadata, while quoted
  snippets remain inert source text and grounded-answer synthesis stays out of
  scope until Task 46.
- Task 47 must permanently remove cohort requests/vectors through the existing
  fragment lifecycle and validate tombstone/restore behavior.
