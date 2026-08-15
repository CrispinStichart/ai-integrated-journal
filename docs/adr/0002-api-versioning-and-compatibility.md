# ADR-0002: API versioning and compatibility

- Status: Accepted
- Date: 2026-08-15
- Deciders: Project maintainers
- Requirements: ARCH-005, DATA-031–033, STATE-003–004, PORT-003–008

## Context

The PWA, API, worker, exports, and future clients evolve at different times. Offline outbox entries may be replayed after an application update, and persisted processor payloads must remain readable. Compatibility therefore covers more than route naming.

## Decision

1. HTTP routes are namespaced under `/api/v1`. The version denotes the HTTP resource and representation contract, not the application release.
2. Shared Zod schemas in `packages/contracts` are the executable source of truth for JSON requests, responses, problem details, and SSE envelopes. OpenAPI 3.1 is generated from those schemas and generation drift fails validation.
3. Changes within `v1` are backward compatible:
   - optional response fields and new endpoints may be added;
   - request fields may become optional only when old behavior remains well defined;
   - existing field meaning, type, requiredness, units, or identifier semantics may not change;
   - fields and stable error codes may not be removed or repurposed;
   - closed enums/discriminated unions may not gain a case unless the contract explicitly marks them extensible and consumers have an unknown-case path.
4. Breaking behavior requires `/api/v2`, parallel schemas, and an explicit migration/deprecation ADR. The local first release makes no time-based compatibility promise, but a published version is not removed until all shipped first-party clients and durable outbox records have a supported migration path.
5. API consumers reject structurally invalid data and preserve unknown fields only in explicitly extensible payloads. Processor-specific payloads are opaque to generic clients and are validated against their immutable processor-version schema.
6. Mutations require `Idempotency-Key`. Reusing a key with the same authenticated actor, operation, and canonical request returns the original outcome; reuse with a different canonical request returns a stable conflict problem. Editable resources require a strong ETag and `If-Match`; stale writes return a conflict without silently merging.
7. Errors use RFC 9457 problem details with a stable application `code` and correlation ID. HTTP status and `code` are contract fields; human-readable `title` and `detail` are not control-flow keys.
8. SSE uses a versioned envelope containing event ID, event type, schema version, occurrence time, and payload. Event IDs support replay; clients encountering an unsupported schema version reconnect through the polling fallback rather than guessing.
9. Binary upload and download routes retain HTTP semantics independently of JSON representation versions: chunk checksums and manifest versions guard uploads, while range requests and immutable ETags guard downloads.
10. Persistence schemas, processor output schemas, queue payloads, and export manifests have their own explicit schema versions. An HTTP version change does not rewrite historical data. Readers either support a stored version or fail with a visible unsupported-version error; they never reinterpret it silently.

## Compatibility verification

- Contract tests parse fixtures from the previous shipped `v1` contract with the current readers.
- OpenAPI generation and diff checks reject unapproved breaking changes.
- Offline/PWA tests replay the oldest supported outbox envelope after an upgrade.
- Migration and export/import tests exercise every supported persisted schema version.

## Consequences

- Additive changes require careful enum design and explicit extension points.
- Old readers may not understand new processor payloads, but can retain and display their common envelope.
- A future `v2` temporarily duplicates route/schema support instead of changing `v1` in place.

## Rejected alternatives

- Unversioned routes make intentional breaking changes indistinguishable from defects.
- Versioning only through media types is harder to operate and inspect for the initial local deployment.
- Treating TypeScript types as the contract provides no runtime validation or language-neutral API description.
