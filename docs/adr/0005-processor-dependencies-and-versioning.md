# ADR-0005: Processor dependencies and versioning

- Status: Accepted
- Date: 2026-08-15
- Deciders: Project maintainers
- Requirements: ARCH-003–004, DATA-030–033, PROC-001–010, EDIT-001–008, STATE-001–005, MODEL-002

## Context

Processors consume immutable source or artifact revisions, may depend on other processors, and evolve independently. Reproducibility and targeted invalidation are impossible if dependencies float implicitly to “latest” or behavior changes in place.

## Decision

### Identity and immutable versions

1. A processor has a stable UUIDv7 identity. Every published processor definition has its own UUIDv7 version ID and an immutable positive monotonic revision number unique within that processor.
2. A human-readable semantic version label is required. Major denotes an intentionally incompatible output meaning/contract, minor a backward-compatible additive contract or capability, and patch a behavior/instruction correction that retains the contract. The immutable version ID—not the label—is authoritative.
3. Any behavior-affecting change creates a new version: kind, instructions/prompt template, input scope/selectors, dependency set, output JSON Schema, reconciliation keys/strategy, requirement mode/default nudge policy, capability requirements, or deterministic validation logic/version.
4. Name, description, enabled state, and the pointer to the current version are mutable processor configuration and audited. A run snapshots the exact effective configuration. Changing enablement schedules/stops future work but never changes history.
5. Publishing validates the complete definition and atomically stores it as immutable. Invalid definitions are not published. Dry runs use a content-addressed draft snapshot recorded with the run but cannot produce authoritative active artifacts.

### Dependency graph

6. Processor-version dependencies reference exact upstream processor version IDs and declared output selectors; they never reference a floating current version. Source selectors likewise resolve to exact revisions when a run begins.
7. The graph of published processor versions must be acyclic. Publication rejects direct cycles, transitive cycles, missing versions, incompatible scopes, and output-selector/schema mismatches before changing the current pointer.
8. A run records exact direct input revision/version IDs. The idempotency fingerprint includes stage, target, ordered canonical inputs, processor version, prompt/instruction hash, effective provider/model configuration, and relevant memory/context versions.
9. Dependency completion schedules downstream work only when required upstream inputs are successful enough for the declared dependency policy. Failure, insufficient information, and partial output remain distinct. Partial input/output is accepted only when the definition explicitly permits it and the result remains labeled partial.
10. When an input changes, invalidation traverses recorded artifact inputs, not the current definition graph. Only actual downstream artifacts become stale. Replacement work uses the explicitly selected current version; old versions and results remain readable.

### Evolution and reporting

11. Advancing a processor's current-version pointer does not mutate, reinterpret, or automatically reprocess historical results. Reprocessing requires preview and explicit confirmation for historical scope.
12. Every result records the processor version, output schema version, prompt/instruction hash, direct inputs, provider/model/configuration, run/attempt, and reconciliation outcome.
13. Generic readers use the common artifact envelope and validate payloads against the exact immutable JSON Schema. Unsupported historical payload schemas remain exportable and inspectable as versioned data; they are not rewritten in place.
14. Reports and statistics select and disclose one processor-version basis, show version partitions, or use an explicitly normalized/reprocessed dataset. They never silently combine incompatible major semantics.
15. Reconciliation outputs are proposals and always pass through ADR-0004 authority resolution. Version upgrades cannot overwrite active manual authority.

## Verification invariants

- Property tests cover graph acyclicity, deterministic topological ordering, and targeted invalidation.
- Integration tests cover publication rollback, exact-version scheduling, fingerprint reuse, retry lineage, and concurrent reconciliation.
- Compatibility fixtures prove old result payloads remain readable/exportable after new versions publish.

## Consequences

- Dependency upgrades require new downstream versions when their declared upstream version changes.
- More metadata is stored per run, but results are reproducible and audit-friendly.
- “Current” is a scheduling default, never a historical interpretation rule.

## Rejected alternatives

- Floating dependencies make the same processor version change meaning over time.
- Mutable processor definitions destroy reproducibility.
- Invalidating every artifact after any change is safe but needlessly expensive and conflicts with targeted lineage requirements.
