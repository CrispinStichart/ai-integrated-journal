# ADR-0003: Semantic-value serialization

- Status: Accepted
- Date: 2026-08-15
- Deciders: Project maintainers
- Requirements: DATA-028, DATA-033, PROC-009–010, NUDGE-002, SEM-001–005, PORT-007

## Context

Unknown, an explicit zero, an explicit absence, neutral, not applicable, uncertain, and known values have different meanings. JavaScript `undefined`, JSON omission, `null`, falsy values, and SQL `NULL` cannot safely carry all of those meanings across APIs, JSONB, statistics, and exports.

## Decision

Fields whose domain needs semantic state use this discriminated JSON union:

```ts
type SemanticValue<T> =
  | { state: "unknown" }
  | { state: "known"; value: T }
  | { state: "none" }
  | { state: "neutral" }
  | { state: "not_applicable" }
  | {
      state: "uncertain";
      value?: T;
      confidence?: number;
    };
```

The canonical wire and JSONB form follows these rules:

1. `state` is required and is the only discriminator. State names are lowercase snake case exactly as shown.
2. `known` requires `value`, including when the value is `0`, `false`, or an empty domain-valid collection. Zero is `{ "state": "known", "value": 0 }`; it is not `none`.
3. `none` means the user/source explicitly establishes absence in that domain. It is not a missing field and not a numeric zero unless a domain policy explicitly maps it for a disclosed calculation.
4. `neutral` is used only by a domain with a meaningful neutral value. Lack of a mood statement remains `unknown` or a separate `insufficient_information` evaluation, never `neutral`.
5. `not_applicable` means the field or requirement was considered and does not apply. It differs from a field omitted because it is not represented by that schema.
6. `uncertain` represents a supported but unresolved or low-certainty claim. `value` may be omitted; `confidence`, when present, is a finite number from 0 through 1. Confidence never upgrades an uncertain value to known automatically.
7. Optional object properties are omitted only when the property is not represented/collected for that object. If the application must distinguish the property's state, the property is required and contains a `SemanticValue`.
8. JSON `null` is not a semantic state and is rejected for semantic-value fields. SQL `NULL` means the column is structurally inapplicable/not represented on that row, not unknown, none, neutral, or zero.
9. Domain-specific schemas restrict which states and `T` values are legal. For example, a domain with no neutral concept excludes `neutral`; generic code may not assume every state is allowed everywhere.
10. Serializers emit no undefined properties and do not coerce falsy values. Deserializers reject unknown state tags for this closed union. A new state is a breaking persisted/API schema change and requires migration/version handling.

Required-information lifecycle is a separate closed state machine (`not_evaluated`, `satisfied`, `insufficient_information`, `pending_user_response`, `dismissed`, `not_applicable`, `failed`). It must not be serialized as `SemanticValue`; `not_applicable` is the only shared spelling and remains context-specific.

Statistics and summaries accept values by explicit domain policy. By default, only `known` participates; `unknown`, `none`, `neutral`, `not_applicable`, and `uncertain` are reported separately. Any imputation or mapping is labeled and versioned.

## Examples

```json
{ "state": "unknown" }
{ "state": "known", "value": 0 }
{ "state": "none" }
{ "state": "neutral" }
{ "state": "not_applicable" }
{ "state": "uncertain", "value": "late evening", "confidence": 0.6 }
```

## Consequences

- Semantic state survives database, API, export, and restore round trips without truthiness bugs.
- Schemas are more verbose than nullable fields.
- Property-based round-trip tests and direct unknown-versus-zero branch coverage are mandatory.

## Rejected alternatives

- `null` plus a value cannot distinguish all required states.
- Sentinel strings mixed with raw values weaken runtime validation and generic handling.
- Treating absence as a default zero or neutral violates SEM-002–004.
