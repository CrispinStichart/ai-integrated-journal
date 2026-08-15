# ADR-0004: Manual and generated authority

- Status: Accepted
- Date: 2026-08-15
- Deciders: Project maintainers
- Requirements: ARCH-004, DATA-024–026, DATA-031, MEM-001–007, FB-001–004, TIME-007, EDIT-005–008, PORT-007, AC-030–032

## Context

AI stages can be retried or re-run under new definitions. Users can correct sources and derived artifacts. Without one authority rule, reconciliation can erase manual work, while treating every generated revision as canonical can turn inference into fact.

## Decision

1. Authority is explicit and orthogonal to authorship:
   - `manual` means a value was authored, corrected, confirmed, pinned, deleted, or explicitly adopted by the user;
   - `generated` means a value was proposed by deterministic or AI processing.
   Actor/provenance fields separately record the user, system stage, processor version, provider, model, and run.
2. Source layers retain their meaning. Typed text and corrected-transcript edits are manual source revisions. Raw STT is an immutable generated capture. Cleaned text is a generated source transform unless the user explicitly edits/adopts a separate manual revision. Generated cleanup never rewrites corrected or raw text.
3. A manual change creates an immutable artifact/revision plus an active manual override for the affected logical artifact and, for structured payloads, the narrowest addressed field/path. The prior version remains auditable.
4. Reconciliation may create or update generated candidates only. It must copy active manual values into the effective view and may not overwrite, clear, or shadow them. A conflicting generated value is retained as a reviewable candidate linked to the active manual override.
5. Authority is field-granular where the output contract supports independent fields. A manual quantity does not freeze unrelated generated fields such as meal context. Whole-artifact overrides are used for manual deletions, merges, splits, confirmations, or values that cannot be safely separated.
6. Manual deletion/suppression is authoritative. Reprocessing cannot resurrect the same logical item as active; a conflicting candidate remains suppressed/reviewable unless evidence supports a genuinely distinct logical item.
7. Only an explicit user command may replace, deactivate, or relinquish an active manual override. Adopting a generated candidate creates a new manual revision; it does not reclassify historical generated data.
8. Occurrence correction and persistent memory/rule creation are separate commands. The latter requires explicit approval, remains visible and revisioned, and affects only future runs/reprocessing that record the memory version as an input.
9. Staleness and authority are independent. A manual value may become stale relative to changed evidence and must be labeled, but remains authoritative until the user resolves or relinquishes it.
10. Imports and restores preserve authority and override history. Unknown authority in an unsupported archive version fails validation rather than defaulting to generated or manual.

The effective-value resolver is deterministic: newest active manual override for the exact target/path wins; otherwise the current non-superseded generated candidate for the selected processor-version basis is used. Competing manual edits use optimistic concurrency and require user resolution rather than timestamp-based last-write-wins.

## Verification invariants

- Reprocessing any supported scope cannot change effective manual values.
- Conflict candidates remain inspectable with both values and provenance.
- Split, merge, delete, confirm, pin, and field correction paths receive direct authority tests.
- Export/import round trips preserve the effective value and the full authority history.

## Consequences

- Effective artifact views require deterministic overlay logic and cannot expose the latest generated row directly.
- Field-level overrides require stable JSON paths tied to immutable output schemas.
- Manual data can be stale; the UI must communicate staleness without demoting authority.

## Rejected alternatives

- Last-write-wins allows asynchronous processing to erase corrections.
- Copying manual values into generated payloads loses provenance and makes later schema reconciliation ambiguous.
- Freezing an entire artifact for every field edit prevents safe updates to unrelated generated fields.
