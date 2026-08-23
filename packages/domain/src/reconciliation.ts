import { DomainInvariantError } from './errors.js';

export type ReconciliationStrategy =
  'append_only' | 'logical_key' | 'replace_scope';

export type ReconciliationOutcome =
  'create' | 'remove_supersede' | 'supersede' | 'unchanged' | 'update';

export interface ReconciliationCandidate {
  readonly logicalKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadHash: string;
}

export interface CurrentReconciliationArtifact {
  readonly artifactId: string;
  readonly versionId: string;
  readonly logicalKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadHash: string;
  readonly processorVersionId: string;
  readonly authority: 'generated' | 'manual';
}

export interface PlannedReconciliationOutcome {
  readonly outcome: ReconciliationOutcome;
  readonly logicalKey: string;
  readonly candidate?: ReconciliationCandidate;
  readonly current?: CurrentReconciliationArtifact;
}

export function reconciliationPayloadCanonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(reconciliationPayloadCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${reconciliationPayloadCanonical(item)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function candidateKey(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    const key = `string:${value}`;
    if (key.length <= 256) return key;
    throw new DomainInvariantError(
      'A reconciliation logical key cannot exceed 256 UTF-16 code units.',
    );
  }
  if (typeof value === 'number' && Number.isFinite(value))
    return `number:${String(value)}`;
  if (typeof value === 'boolean') return `boolean:${String(value)}`;
  throw new DomainInvariantError(
    'A reconciliation logical key must be a non-empty string, finite number, or boolean.',
  );
}

/**
 * Converts validated processor output into stable logical candidates. The
 * configured logical key is read only from each item; it is never inferred
 * from journal text or array order.
 */
export function processorReconciliationCandidates(input: {
  readonly strategy: ReconciliationStrategy;
  readonly logicalKey?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly hashPayload: (payload: Readonly<Record<string, unknown>>) => string;
}): readonly ReconciliationCandidate[] {
  if (input.strategy === 'replace_scope') {
    return Object.freeze([
      Object.freeze({
        logicalKey: 'scope',
        payload: input.payload,
        payloadHash: input.hashPayload(input.payload),
      }),
    ]);
  }
  if (input.strategy === 'append_only') {
    const payloadHash = input.hashPayload(input.payload);
    return Object.freeze([
      Object.freeze({
        logicalKey: `payload:${payloadHash}`,
        payload: input.payload,
        payloadHash,
      }),
    ]);
  }
  if (input.logicalKey === undefined)
    throw new DomainInvariantError(
      'Logical-key reconciliation requires a configured logical key.',
    );
  const items = input.payload.items;
  if (!Array.isArray(items))
    throw new DomainInvariantError(
      'Logical-key reconciliation requires an items array in processor output.',
    );
  const candidates = items.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw new DomainInvariantError(
        'Every logical-key reconciliation item must be an object.',
      );
    const payload = item as Readonly<Record<string, unknown>>;
    const logicalKey = candidateKey(payload[input.logicalKey as string]);
    return Object.freeze({
      logicalKey,
      payload,
      payloadHash: input.hashPayload(payload),
    });
  });
  const keys = new Set<string>();
  for (const candidate of candidates) {
    if (keys.has(candidate.logicalKey))
      throw new DomainInvariantError(
        'Processor output contains duplicate reconciliation logical keys.',
      );
    keys.add(candidate.logicalKey);
  }
  return Object.freeze(candidates);
}

/** Plans deterministic state transitions without mutating immutable versions. */
export function planReconciliation(input: {
  readonly strategy: ReconciliationStrategy;
  readonly completeness: 'complete' | 'partial';
  readonly processorVersionId: string;
  readonly candidates: readonly ReconciliationCandidate[];
  readonly current: readonly CurrentReconciliationArtifact[];
}): readonly PlannedReconciliationOutcome[] {
  const currentByKey = new Map(
    input.current.map((artifact) => [artifact.logicalKey, artifact]),
  );
  const outcomes: PlannedReconciliationOutcome[] = [];
  for (const candidate of [...input.candidates].sort((left, right) =>
    left.logicalKey.localeCompare(right.logicalKey),
  )) {
    const current = currentByKey.get(candidate.logicalKey);
    currentByKey.delete(candidate.logicalKey);
    if (current === undefined) {
      outcomes.push({
        outcome: 'create',
        logicalKey: candidate.logicalKey,
        candidate,
      });
      continue;
    }
    if (
      current.authority === 'manual' ||
      current.payloadHash === candidate.payloadHash
    ) {
      outcomes.push({
        outcome: 'unchanged',
        logicalKey: candidate.logicalKey,
        candidate,
        current,
      });
      continue;
    }
    outcomes.push({
      outcome:
        current.processorVersionId === input.processorVersionId
          ? 'update'
          : 'supersede',
      logicalKey: candidate.logicalKey,
      candidate,
      current,
    });
  }
  if (input.strategy !== 'append_only' && input.completeness === 'complete') {
    for (const current of [...currentByKey.values()].sort((left, right) =>
      left.logicalKey.localeCompare(right.logicalKey),
    )) {
      outcomes.push({
        outcome:
          current.authority === 'manual' ? 'unchanged' : 'remove_supersede',
        logicalKey: current.logicalKey,
        current,
      });
    }
  }
  return Object.freeze(outcomes.map((outcome) => Object.freeze(outcome)));
}
