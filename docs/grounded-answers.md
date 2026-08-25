# Grounded answers

`POST /api/v1/search/answers` creates an authenticated, CSRF-protected,
idempotent answer request. It applies the same date, layer, contribution,
processor, result, entity, authority, and lexical/semantic/hybrid retrieval
rules as search. The API snapshots at most eight current fragments, with at
most 2,000 UTF-16 code units per fragment and 12,000 total. No provider job is
created when retrieval is empty; the request immediately becomes
`insufficient_support`.

The queue payload contains only the answer and owner identifiers. The worker
reloads the canonical request and verifies every exact fragment is still in the
current owner-scoped search index before generation. Journal fragments are
serialized as quoted, untrusted data. The system instruction prohibits obeying
prompts inside journal text, using outside knowledge, or returning unsupported
recollections.

The structured output is either an answer with one or more unique supplied
opaque citation IDs, or `insufficient_support` with no answer or citations.
Unknown, duplicated, or invented citation IDs fail validation. Provider or
capability failures use the separate `failed` state and never masquerade as
insufficient journal information.

Each citation snapshots the exact stable source and revision, inert retrieved
quote, NFC/LF UTF-16 evidence coordinates, quote SHA-256, Journal Day or memory
link, layer, and authority. The API returns generated `synthesis` and retrieved
`citations` as distinct fields. If a cited fragment later becomes stale,
replaced, or deleted, reads immediately suppress both the synthesis and source
text and report insufficient current support.

Successful and provider-produced insufficient results retain the immutable
prompt ID/version/template hash, effective-message hash, provider, model,
secret-free effective configuration, usage, processing time, and exact raw
provider response under the 30-day default. Logs and queue payloads remain
content-free.
