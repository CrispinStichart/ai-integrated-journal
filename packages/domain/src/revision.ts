import { DomainInvariantError, OptimisticConcurrencyError } from './errors.js';
import type { UtcInstant } from './temporal.js';

declare const revisionNumberBrand: unique symbol;

export type RevisionNumber = number & { readonly [revisionNumberBrand]: true };

export function revisionNumber(value: number): RevisionNumber {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainInvariantError(
      'A revision number must be a positive safe integer.',
    );
  }
  return value as RevisionNumber;
}

export function nextRevision(current: RevisionNumber): RevisionNumber {
  return revisionNumber(current + 1);
}

export function assertExpectedRevision(
  expected: RevisionNumber,
  actual: RevisionNumber,
): void {
  if (expected !== actual) {
    throw new OptimisticConcurrencyError(expected, actual);
  }
}

export interface AppendOnlyRevision<EntityId, RevisionId, Value> {
  readonly entityId: EntityId;
  readonly revisionId: RevisionId;
  readonly revision: RevisionNumber;
  readonly value: Readonly<Value>;
  readonly createdAt: UtcInstant;
}

export function appendRevision<EntityId, RevisionId, Value>(input: {
  readonly entityId: EntityId;
  readonly revisionId: RevisionId;
  readonly currentRevision?: RevisionNumber;
  readonly expectedRevision?: RevisionNumber;
  readonly value: Value;
  readonly createdAt: UtcInstant;
}): Readonly<AppendOnlyRevision<EntityId, RevisionId, Value>> {
  if (input.currentRevision === undefined) {
    if (input.expectedRevision !== undefined) {
      throw new OptimisticConcurrencyError(input.expectedRevision, 0);
    }
  } else {
    if (input.expectedRevision === undefined) {
      throw new DomainInvariantError(
        'Appending to an existing entity requires an expected revision.',
      );
    }
    assertExpectedRevision(input.expectedRevision, input.currentRevision);
  }

  return Object.freeze({
    entityId: input.entityId,
    revisionId: input.revisionId,
    revision:
      input.currentRevision === undefined
        ? revisionNumber(1)
        : nextRevision(input.currentRevision),
    value: Object.freeze(input.value),
    createdAt: input.createdAt,
  });
}
