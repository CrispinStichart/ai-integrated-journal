import { DomainInvariantError } from './errors.js';
import type { RevisionNumber } from './revision.js';

export type Authority = 'manual' | 'generated';

export interface AuthorityCandidate<T> {
  readonly authority: Authority;
  readonly revision: RevisionNumber;
  readonly value: T;
  readonly active: boolean;
  readonly superseded: boolean;
}

/** Manual authority wins regardless of the arrival order of generated candidates. */
export function resolveEffectiveValue<T>(
  candidates: readonly AuthorityCandidate<T>[],
): AuthorityCandidate<T> {
  const eligible = candidates.filter(
    (candidate) => candidate.active && !candidate.superseded,
  );
  const manual = eligible.filter(
    (candidate) => candidate.authority === 'manual',
  );
  const pool = manual.length > 0 ? manual : eligible;
  const selected = pool.reduce<AuthorityCandidate<T> | undefined>(
    (newest, candidate) =>
      newest === undefined || candidate.revision > newest.revision
        ? candidate
        : newest,
    undefined,
  );

  if (selected === undefined) {
    throw new DomainInvariantError(
      'No active, non-superseded authority candidate exists.',
    );
  }
  return selected;
}
