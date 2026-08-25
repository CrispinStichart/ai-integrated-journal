# Semantic and hybrid search

`GET /api/v1/search` accepts `mode=lexical`, `mode=semantic`, or `mode=hybrid`.
Lexical remains the API default and requires no provider. The Search UI defaults
to hybrid and visibly reports when it falls back to lexical.

Semantic retrieval is optional. The configured embedding capability receives
only one bounded source chunk per call (2,000 characters) or the bounded search
query (200 characters). Lifecycle-triggered requests are dispatched as
identifier-only jobs; journal text is reloaded from PostgreSQL and excluded from
queue payloads and logs. A worker attempt processes at most sixteen chunks and
continues later for longer exact revisions.

Vectors are compared only when owner, provider, model, model version, public
configuration fingerprint, and dimension all match. Completed reindexes become
visible atomically; partial, failed, stale, replaced, and deleted fragments do
not participate. Filters from lexical search apply before semantic ranking.
Each result retains its exact immutable revision link and is labeled as retrieved
source/result content, never generated synthesis.

Hybrid mode uses reciprocal-rank fusion (`k=60`) over at most 200 candidates
from each retriever. Agreement between retrievers raises a result without
pretending their raw scores are directly comparable. Stable ties use Journal
Day descending and fragment UUID ascending.

Fallback reasons are `provider_unavailable`, `provider_failed`, and
`semantic_index_unavailable`. In every case the request returns local lexical
results and does not change journal content. Grounded generated answers are not
part of this endpoint.
