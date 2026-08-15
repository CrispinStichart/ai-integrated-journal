import { describe, expect, it } from 'vitest';

import {
  DomainInvariantError,
  activeState,
  createAuditEvent,
  createUuidV7,
  isDeleted,
  parseUtcInstant,
  restore,
  softDelete,
} from '../src/index.js';

describe('soft deletion and recovery (DATA-011, EDIT-005)', () => {
  it('preserves deletion provenance and supports an explicit restoration', () => {
    const active = activeState<'owner'>();
    const deleted = softDelete(active, {
      deletedAt: parseUtcInstant('2026-08-15T10:00:00Z'),
      deletedBy: 'owner',
      reason: 'requested',
    });
    const restored = restore(deleted, {
      restoredAt: parseUtcInstant('2026-08-15T11:00:00Z'),
      restoredBy: 'owner',
    });

    expect(isDeleted(active)).toBe(false);
    expect(isDeleted(deleted)).toBe(true);
    expect(deleted).toMatchObject({ state: 'deleted', reason: 'requested' });
    expect(restored).toMatchObject({ state: 'active', restoredBy: 'owner' });
    expect(Object.isFrozen(deleted)).toBe(true);
  });

  it('rejects duplicate deletion and restoration of an active entity', () => {
    const active = activeState<'owner'>();
    const deleted = softDelete(active, {
      deletedAt: parseUtcInstant('2026-08-15T10:00:00Z'),
      deletedBy: 'owner',
    });

    expect(() =>
      softDelete(deleted, {
        deletedAt: parseUtcInstant('2026-08-15T11:00:00Z'),
        deletedBy: 'owner',
      }),
    ).toThrow(DomainInvariantError);
    expect(() =>
      restore(active, {
        restoredAt: parseUtcInstant('2026-08-15T11:00:00Z'),
        restoredBy: 'owner',
      }),
    ).toThrow('not deleted');
  });
});

describe('content-free audit primitives (DATA-026, PROV-004)', () => {
  const makeEvent = () => ({
    id: createUuidV7<'audit-event'>(),
    action: 'contribution.deleted',
    actor: { kind: 'system' as const, component: 'retention' },
    target: { type: 'contribution', id: createUuidV7<'contribution'>() },
    occurredAt: parseUtcInstant('2026-08-15T10:00:00Z'),
    correlationId: createUuidV7<'correlation'>(),
    beforeHash: 'a'.repeat(64),
    afterHash: 'b'.repeat(64),
    metadata: { gracePeriodDays: 30, recoverable: true },
  });

  it('creates an immutable audit event with identifiers, hashes, and safe metadata', () => {
    const event = createAuditEvent(makeEvent());

    expect(event.action).toBe('contribution.deleted');
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.metadata)).toBe(true);
  });

  it.each([
    { action: '', targetType: 'contribution', beforeHash: 'a'.repeat(64) },
    { action: 'deleted', targetType: '', beforeHash: 'a'.repeat(64) },
    { action: 'deleted', targetType: 'contribution', beforeHash: 'NOT-A-HASH' },
  ])(
    'rejects malformed audit event fields',
    ({ action, targetType, beforeHash }) => {
      const event = makeEvent();
      expect(() =>
        createAuditEvent({
          ...event,
          action,
          target: { ...event.target, type: targetType },
          beforeHash,
        }),
      ).toThrow(DomainInvariantError);
    },
  );
});
