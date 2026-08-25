# Lexical search

`GET /api/v1/search` performs authenticated, owner-scoped PostgreSQL full-text
retrieval. It is local and remains available without an AI provider.

The required `q` parameter accepts unquoted prefix terms and quoted phrases.
Optional filters are `layers` and `contributionTypes` as comma-separated values,
`dateFrom`, `dateTo`, `processorId`, `resultType`, `entity`, and `authority`.
`limit` is bounded to 50. `cursor` is opaque and valid only for the exact query
and filter set that issued it.

Results identify a stable source plus its exact immutable revision. Journal
material links to `/journal/{date}` with source/revision query parameters;
approved memories link to the memory view. Snippets are arrays of inert text
segments with a highlight flag, never HTML. Generated results are separately
labeled from manual/retrieved source material.

The index contains only current, searchable state. Advancing a revision removes
the old fragment in the same transaction. Soft deletion, transcript staleness,
artifact supersession/staleness, manual authority changes, and memory
disable/delete transitions also take effect transactionally. See ADR-0011 for
the persistence and ranking decision.

Optional semantic and hybrid modes build on the same exact-revision lifecycle
authority; see `semantic-and-hybrid-search.md` and ADR-0012.
