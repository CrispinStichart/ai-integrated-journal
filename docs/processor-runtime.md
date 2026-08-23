# Processor runtime

Task 32 adds the identifier-only `journal.processing` worker path and the first durable processor result envelope. A run binds one immutable processor version, one contribution or Journal Day target, the exact source revisions selected when it is queued, the exact temporal context of each source, the prompt-assembly version and hash, and the requested secret-free configuration. Queue payloads contain only the run ID, processor-version ID, and fingerprint; journal content is reloaded from the immutable database revisions.

## Input and execution contract

Inputs have stable labels of the form `typed_text:<revision-id>`, `corrected_transcript:<revision-id>`, or `cleaned_transcript:<revision-id>`. Typed text and transcript layers remain sources; generated processor results are stored as generated observations, interpretations, source transforms, or other declared results. The data envelope retains capture instant, capture timezone, journal date, journal timezone, and assignment source so relative language is never evaluated against worker time.

The immutable processor version controls prompt, canonical-input, runtime, and result bounds. Oversize input fails closed unless the version explicitly permits partial inputs. When partial input is permitted, truncation occurs on a valid UTF-16 boundary and the provider or deterministic implementation must return `completeness: "partial"`; a complete claim is rejected. Runtime timeouts use the definition limit, queue cancellation is honored, exact retries retain their fingerprint/configuration, and terminal output is inserted transactionally and idempotently.

Deterministic versions resolve an explicitly registered local implementation. Structured-generation versions resolve the provider-neutral capability port and retain provider/model/effective configuration, usage, processing duration, exact processor/prompt versions, effective-message hash, and the immutable raw response under the ADR-0009 30-day default. Embeddings are not an execution mode for this result-producing runtime.

## Validation, evidence, and safety

Generated values cross a data-only envelope and are validated against the immutable bounded JSON Schema before persistence. Result bytes are checked before storage. Evidence must cite an included stable source label, use zero-based end-exclusive UTF-16 offsets over NFC/LF text, reproduce the exact quote, and remain inside any partial prefix. Audio ranges are accepted only when retained transcript segment timing supports both the cited text and time range. Stored evidence retains the exact source revision and SHA-256 quote hash.

Journal content is placed only in the user data message and is explicitly declared untrusted. Provider output has no code, tool, SQL, or HTML execution channel and can only become inert validated JSONB plus evidence rows. Jobs, logs, metrics, and fingerprints contain no journal text, prompts, provider responses, storage keys, or checksums.

## Persistence and current boundary

Migration `20260823063713_aromatic_doctor_strange.sql` adds processor runs, results, immutable run inputs, and evidence. Migration `20260823065040_exotic_bloodstorm.sql` replaces the initial nullable-target uniqueness index with scope-specific unique attempt indexes. Results remain generated and unmodified in this task.

The runtime currently schedules contribution and Journal Day source inputs. Exact processor-result dependency edges and artifact-set inputs begin with task 33's provenance graph. Task 34 owns reconciliation into stable logical artifacts and concurrent whole-day serialization. Date-range orchestration, previews, public execution/cancellation APIs, and progress are task 36. No task-33-or-later invalidation, reconciliation, override, or reprocessing behavior is implemented here.
