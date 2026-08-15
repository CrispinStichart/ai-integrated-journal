import { DomainInvariantError } from './errors.js';
import type { UuidV7 } from './identity.js';
import type { UtcInstant } from './temporal.js';

export type AuditActor =
  | { readonly kind: 'user'; readonly id: UuidV7<'user'> }
  | { readonly kind: 'system'; readonly component: string };

export interface AuditTarget {
  readonly type: string;
  readonly id: UuidV7;
  readonly revisionId?: UuidV7;
}

export interface AuditEvent {
  readonly id: UuidV7<'audit-event'>;
  readonly action: string;
  readonly actor: AuditActor;
  readonly target: AuditTarget;
  readonly occurredAt: UtcInstant;
  readonly correlationId: UuidV7<'correlation'>;
  readonly beforeHash?: string;
  readonly afterHash?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

const SHA_256_PATTERN = /^[0-9a-f]{64}$/;

/** Creates a content-free, append-only audit record. */
export function createAuditEvent(event: AuditEvent): Readonly<AuditEvent> {
  if (
    event.action.trim().length === 0 ||
    event.target.type.trim().length === 0
  ) {
    throw new DomainInvariantError(
      'Audit action and target type must be non-empty.',
    );
  }
  for (const hash of [event.beforeHash, event.afterHash]) {
    if (hash !== undefined && !SHA_256_PATTERN.test(hash)) {
      throw new DomainInvariantError(
        'Audit hashes must be lowercase SHA-256 hex values.',
      );
    }
  }
  return Object.freeze({
    ...event,
    ...(event.metadata === undefined
      ? {}
      : { metadata: Object.freeze({ ...event.metadata }) }),
  });
}
