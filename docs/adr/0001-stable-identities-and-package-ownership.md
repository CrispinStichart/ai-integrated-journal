# ADR-0001: Stable identities and package ownership

- Status: Accepted
- Date: 2026-08-15
- Deciders: Project maintainers
- Requirements: ARCH-001–004, DATA-004, DATA-020, DATA-030–032, PORT-005

## Context

Journal data is created offline, revised without losing history, referenced by evidence and exports, and processed asynchronously. IDs therefore cannot depend on a database round trip or change when content, dates, providers, or storage backends change. The monorepo also needs one owner for each contract so applications do not create competing domain models.

## Decision

### Identity

1. Durable entities and immutable revisions use UUIDv7 identifiers represented at process and API boundaries as canonical lowercase hyphenated strings. IDs are opaque: ordering may be used for pagination only with an explicit secondary sort, never to derive business meaning.
2. The creating tier generates the ID before the first durable attempt. The browser creates contribution and recording IDs before offline capture; server-side services create IDs for server-originated entities. A retry reuses the same ID and idempotency key.
3. Stable logical entities and their immutable history have separate IDs. Editing creates a new revision/version ID and advances the stable entity's current pointer with optimistic concurrency. Reassignment, correction, soft deletion, restoration, provider changes, and reprocessing do not replace the stable ID.
4. External relationships, provenance, evidence, exports, queue payloads, and audit events reference stable IDs plus exact revision/version IDs where the content version matters. Natural keys such as journal date may enforce uniqueness but are not identity.
5. IDs are never reused. Import and restore preserve IDs. A collision with non-identical existing data fails visibly; restore does not remap silently.
6. TypeScript uses branded ID types owned by the domain package. Wire schemas validate UUIDv7 and expose strings; persistence maps those values to PostgreSQL `uuid` columns.

### Package ownership

The package that owns a concept is the only package that defines its authoritative behavior or public type:

| Owner | Responsibility |
| --- | --- |
| `packages/domain` | Branded identities, value objects, entities, invariants, authority and reconciliation policies, lifecycle state machines, and domain-facing ports. It has no application, framework, queue, provider, storage-adapter, or persistence dependency. |
| `packages/contracts` | Zod wire schemas, DTOs, event envelopes, RFC 9457 errors, and OpenAPI generation. It may map domain concepts but does not reimplement domain policy. |
| `packages/database` | Drizzle schema, migrations, repositories, transactions, and persistence mappings. It implements persistence needs without exporting Drizzle rows as public application contracts. |
| `packages/storage` | The provider-neutral `BlobStore` contract and storage adapters. Provider SDK types do not escape adapters. |
| `packages/ai` | Capability-based AI ports, provider adapters, model/config snapshots, and prompt request/response plumbing. |
| `packages/processors` | Processor definition schema, dependency validation, runtime orchestration, built-in definitions, and reconciliation integration. It consumes domain and AI contracts. |
| `packages/config` | Startup configuration parsing and typed configuration values. |
| `packages/observability` | Content-safe logging, metrics, tracing, and redaction. |
| `packages/test-support` | Synthetic factories, fixtures, fake providers, and infrastructure harnesses; never production policy. |
| `apps/*` | Composition roots and delivery adapters only. Applications may coordinate packages but may not become the sole owner of reusable policy or wire contracts. |

Dependencies flow from applications toward packages and from adapters toward domain-facing contracts. Cross-package imports use declared package exports. Cycles, application-to-application imports, and source-relative imports across package boundaries are prohibited by automated boundary checks.

When a change spans owners, the domain invariant and wire contract are changed first, then adapters and applications. Database schema and public contract changes have one active owner at a time.

## Consequences

- Offline creation and idempotent replay do not need temporary server IDs.
- Audit, evidence, and export relationships survive edits and migrations.
- Stable entities require explicit revision tables and current-version pointers.
- UUIDv7 validation, collision behavior, package boundaries, and import/restore identity preservation require automated tests.

## Rejected alternatives

- Database-generated sequential IDs prevent authoritative offline identity and leak ordering.
- Content hashes cannot identify mutable logical entities and collide semantically when identical content is intentional.
- Defining shared shapes independently in each application invites contract and policy drift.
