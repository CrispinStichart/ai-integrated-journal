# Processor runtime

Task 32 adds the identifier-only `journal.processing` worker path and the first durable processor result envelope. A run binds one immutable processor version, one contribution or Journal Day target, the exact source revisions selected when it is queued, the exact temporal context of each source, the prompt-assembly version and hash, and the requested secret-free configuration. Queue payloads contain only the run ID, processor-version ID, and fingerprint; journal content is reloaded from the immutable database revisions.

## Input and execution contract

Inputs have stable labels of the form `typed_text:<revision-id>`, `corrected_transcript:<revision-id>`, or `cleaned_transcript:<revision-id>`. Typed text and transcript layers remain sources; generated processor results are stored as generated observations, interpretations, source transforms, or other declared results. The data envelope retains capture instant, capture timezone, journal date, journal timezone, and assignment source so relative language is never evaluated against worker time.

The immutable processor version controls prompt, canonical-input, runtime, and result bounds. Oversize input fails closed unless the version explicitly permits partial inputs. When partial input is permitted, truncation occurs on a valid UTF-16 boundary and the provider or deterministic implementation must return `completeness: "partial"`; a complete claim is rejected. Runtime timeouts use the definition limit, queue cancellation is honored, exact retries retain their fingerprint/configuration, and terminal output is inserted transactionally and idempotently.

Deterministic versions resolve an explicitly registered local implementation. Structured-generation versions resolve the provider-neutral capability port and retain provider/model/effective configuration, usage, processing duration, exact processor/prompt versions, effective-message hash, and the immutable raw response under the ADR-0009 30-day default. Embeddings are not an execution mode for this result-producing runtime.

## Validation, evidence, and safety

Generated values cross a data-only envelope and are validated against the immutable bounded JSON Schema before persistence. Result bytes are checked before storage. Evidence must cite an included stable source label, use zero-based end-exclusive UTF-16 offsets over NFC/LF text, reproduce the exact quote, and remain inside any partial prefix. Audio ranges are accepted only when retained transcript segment timing supports both the cited text and time range. Stored evidence retains the exact source revision and SHA-256 quote hash.

Journal content is placed only in the user data message and is explicitly declared untrusted. Provider output has no code, tool, SQL, or HTML execution channel and can only become inert validated JSONB plus evidence rows. Jobs, logs, metrics, and fingerprints contain no journal text, prompts, provider responses, storage keys, or checksums.

## Reconciliation

Task 34 keeps the task-32 result row as the immutable, exact validated proposal and reconciles it into a separate stable-artifact layer in the same completion transaction. `replace_scope` has the stable key `scope`; `logical_key` requires a bounded scalar key on every object in `payload.items`; and `append_only` uses the canonical payload hash. Duplicate or invalid logical keys fail the run rather than falling back to array position or journal text.

For a complete logical-key or replace-scope result, the planner emits `create`, `update`, `supersede`, `remove_supersede`, or `unchanged`. A processor-version change distinguishes supersession from an update. Partial output may create or update included items but never removes unseen current items. Each generated change creates an immutable artifact version linked to its source result, run, and exact processor version. Removal only deactivates the stable artifact and supersedes its current version; all payload history remains inspectable.

Processor completion takes a PostgreSQL transaction advisory lock derived only from the Journal Day ID. This serializes all processor reconciliation for that day, including different processors, so a day-level consumer cannot observe a half-reconciled state. The reconciliation run primary key, stable scope/logical-key indexes, per-artifact revision uniqueness, per-run/artifact uniqueness, and one-active-version partial index enforce idempotency even under duplicate delivery. A replay with the same run/result/hash returns the stored outcomes; attempting to reuse the run with different immutable output fails visibly.

Invalidating a generated result supersedes only active logical versions sourced from the impacted exact result and deactivates their stable artifacts. A replacement run reuses the stable identity and appends history. Manual authority is never mutated or removed by the task-34 planner. Task 35 layers immutable field-granular manual revisions and whole-artifact confirmations/tombstones over these generated versions. A conflicting later proposal is retained as a reviewable candidate linked to the exact active manual revision; adoption, dismissal, or override release always requires an explicit user command. Split and merge create atomic manual source tombstones and result artifacts without changing generated history.

The provenance endpoint exposes reconciliation strategy, completeness, a content-free input hash, and ordered outcome records. Jobs and logs still contain identifiers only; artifact payloads and logical keys are not emitted to queues or logs.

## Persistence and current boundary

Migration `20260823063713_aromatic_doctor_strange.sql` adds processor runs, results, immutable run inputs, and evidence. Migration `20260823065040_exotic_bloodstorm.sql` replaces the initial nullable-target uniqueness index with scope-specific unique attempt indexes. Migration `20260823164705_free_thunderbolt_ross.sql` adds stable artifacts, immutable artifact versions, reconciliation records, and database idempotency constraints. Migration `20260823171935_manual-artifact-overrides.sql` adds artifact edit revisions, reviewable generated candidates, edit idempotency, and monotonic artifact ETags.

The runtime schedules contribution and Journal Day source inputs, binds exact processor-result dependency edges, reconciles completed output into stable logical artifacts, and protects active manual authority. Date-range orchestration, previews, public execution/cancellation APIs, and progress remain task 36.

Task 37 adds the separate feedback and memory lifecycle described in
`docs/feedback-and-memories.md`. It does not weaken artifact authority:
occurrence edits still create manual revisions, persistent rules require a
separate approved command, and later processing retains generated disagreement
as a reviewable candidate. Newly queued STT runs include only approved visible
transcription memories and bind their exact immutable revision IDs in the
existing context snapshot and input fingerprint.
