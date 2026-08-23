# Processor definition management

Processor definitions are stable objects with immutable published versions. A published version records its semantic label, kind, instructions, input scope/selectors, exact upstream version dependencies, JSON Schema output contract, reconciliation strategy, requirement and nudge defaults, capability requirements, default enablement, partial-input policy, resource limits, and fixed output-safety policy.

Mutable processor configuration is deliberately narrow: display name, purpose, enabled state, current scheduling version, and effective requirement mode. These changes advance a strong processor ETag and append a content-safe audit event. They do not reinterpret or edit historical versions. Selecting an older version only changes future scheduling; historical results retain their exact original version.

## Validation and bounds

Publishing is atomic and rejects the entire version before changing the current pointer when validation fails. The supported JSON Schema dialect is draft 2020-12 with a deliberately bounded keyword subset. Schemas must have a closed object root and are limited to depth 8, 128 schema nodes, 64 properties per object, 64 enum values, and 256-character patterns. `$ref` and other unbounded or executable extension mechanisms are not supported.

Exact dependencies must exist, target another processor, resolve their JSON Pointer output selector against that version's schema, and form an acyclic processor-version graph. Definitions also bound instructions to 16,000 characters and configure prompt, canonical input, runtime, and result limits within server-enforced maxima.

Journal sources are untrusted prompt data. The fixed `data_only` output policy prohibits code execution, tool calls, SQL, and HTML. Later runtime work must preserve that boundary: model output is schema-validated data and cannot directly mutate canonical records or enter an executable sink.

## API

All routes are authenticated under `/api/v1`:

- `GET /processors` and `GET /processors/{id}` inspect configuration and complete immutable version history.
- `POST /processors` creates a stable processor and its initial version atomically.
- `POST /processors/{id}/versions` publishes a new immutable version and advances the current pointer.
- `PATCH /processors/{id}` changes only mutable configuration.
- `POST /processor-versions/dry-run` validates a content-addressed draft without publishing it or producing authoritative artifacts.

Mutations require CSRF protection and idempotency keys. Configuration/version-pointer changes additionally require the strong ETag `"processor-{configRevision}"`. Responses use the shared Zod/OpenAPI contracts and RFC 9457 problem details.

The Processors screen exposes enablement, requirement mode, current-version selection, immutable history, draft creation, JSON definition editing, and dry-run issues. It uses semantic daisyUI components/tokens and remains keyboard and touch operable.
