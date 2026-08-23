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

## Built-in mood contract

The version-2 mood processor consumes the complete Journal Day and reconciles
logical-key items. Every contextual statement is an independent
`mood_observation` artifact with exact evidence. The single reserved
`daily-mood-aggregate` item is a separately inspectable interpretation; it does
not replace morning, evening, or otherwise changing observations. This shape
also lets an active manual aggregate rating remain authoritative while unrelated
generated observations continue to reconcile normally.

The aggregate rating is a tagged semantic value. No observation produces
`informationStatus: "insufficient_information"` and `{ state: "unknown" }`,
with no fabricated evidence. Explicitly neutral mood uses `{ state: "neutral" }`.
Only `{ state: "known", value: number }` is eligible for numerical averages;
unknown, neutral, and uncertain states are excluded unless a future versioned
rule explicitly discloses imputation. Known aggregates must cite evidence also
cited by their source observations and record a disclosed derivation rule.

The immutable instructions and deterministic validator both require
`clinicalFrame: "journaling_analysis"`. They reject clinical or diagnostic
claims before persistence. The UI repeats the non-clinical framing and shows
the exact source revisions, UTF-16 ranges, quotes, optional audio ranges,
processor version, provider, and model used for every result.

## Built-in sleep and temporal contract

The version-2 sleep processor emits each nightly sleep, nap, and other sleep
period as a distinct logical-key item. Its immutable instructions and
deterministic validator enforce the wake-date convention for known generated
nightly sleep associations. Optional quality, start, end, duration,
interruptions, context, and subjective-effect fields remain omitted when the
source does not establish them. The result-level information status keeps
unmentioned sleep distinct from directly evidenced explicit no sleep.

Every associated date retains the original temporal phrase, known or uncertain
state, resolved date or reviewable candidates, IANA journal timezone,
confidence, manual-authority flag, and the exact capture/journal context plus
versioned resolution rule. Relative dates use the contribution's effective
Journal Day rather than processing time. In particular, `Tomorrow` for a
contribution assigned to `2026-08-23` resolves to `2026-08-24` even when its
actual 00:30 capture instant falls on the next local calendar date.

Ambiguous late-night language remains uncertain without a forced date. A user
correction creates a manual resolution and immutable artifact revision; later
generated disagreement remains a reviewable candidate. The artifact card
discloses the wake-date rule, original phrase, candidate or resolved dates,
temporal resolution basis, exact evidence, and the existing correction action.

## Built-in tasks and intentions contract

The version-2 tasks and intentions processor preserves six distinct statement
classes: completed, firm, tentative, contemplative, suggested, and general
interest. Their lifecycle states are deterministic: completed actions are
completed, firm intentions are pending, tentative intentions remain possible,
and contemplation, suggestions, and interests are not actionable. Every item
is an observation only; provider output has no path that creates or authorizes
an external task. Broader things to remember retain their supported category,
including media recommendations, contacts, places, purchases, and research.

An absent temporal phrase means the due-date field is omitted. A present but
unsupported phrase is retained explicitly as unsupported, without a resolved
date. Known or ambiguous dates retain the exact phrase, evidence ordinals,
timezone, confidence, immutable capture and Journal Day context, and versioned
resolution rule. The deterministic validator recomputes the resolution from
that recorded context and rejects a date whose phrase is absent from its cited
evidence, whose evidence is not attached to the item, or whose result was
invented. Manual task-date corrections remain authoritative and later generated
disagreement is reviewable through the existing candidate flow.

The artifact card labels intention strength and status in text, distinguishes
supported, absent, ambiguous, and unsupported dates, discloses resolution
context and exact evidence, and repeats that no external task was created.
