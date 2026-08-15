import { DomainInvariantError } from './errors.js';
import type { UtcInstant } from './temporal.js';

export type RecoverableState<Actor> =
  | {
      readonly state: 'active';
      readonly restoredAt?: UtcInstant;
      readonly restoredBy?: Actor;
    }
  | {
      readonly state: 'deleted';
      readonly deletedAt: UtcInstant;
      readonly deletedBy: Actor;
      readonly reason?: string;
    };

export function activeState<Actor>(): RecoverableState<Actor> {
  return Object.freeze({ state: 'active' });
}

export function softDelete<Actor>(
  current: RecoverableState<Actor>,
  deletion: {
    readonly deletedAt: UtcInstant;
    readonly deletedBy: Actor;
    readonly reason?: string;
  },
): RecoverableState<Actor> {
  if (current.state === 'deleted') {
    throw new DomainInvariantError('The entity is already deleted.');
  }
  return Object.freeze({ state: 'deleted', ...deletion });
}

export function restore<Actor>(
  current: RecoverableState<Actor>,
  restoration: { readonly restoredAt: UtcInstant; readonly restoredBy: Actor },
): RecoverableState<Actor> {
  if (current.state === 'active') {
    throw new DomainInvariantError('The entity is not deleted.');
  }
  return Object.freeze({ state: 'active', ...restoration });
}

export function isDeleted<Actor>(state: RecoverableState<Actor>): boolean {
  return state.state === 'deleted';
}
