import { describe, expect, it } from 'vitest';

import {
  DomainInvariantError,
  InvalidStateTransitionError,
  OptimisticConcurrencyError,
  appendRevision,
  assertExpectedRevision,
  canTransitionProcessing,
  isTerminalProcessingStatus,
  nextRevision,
  parseUtcInstant,
  revisionNumber,
  transitionProcessing,
  transitionRequirementEvaluation,
} from '../src/index.js';

describe('append-only revisions and optimistic concurrency (DATA-026, EDIT-005, EDIT-006)', () => {
  it('creates an immutable first revision and appends the next revision', () => {
    const first = appendRevision({
      entityId: 'entity',
      revisionId: 'revision-1',
      value: { text: 'first' },
      createdAt: parseUtcInstant('2026-08-15T10:00:00Z'),
    });
    const second = appendRevision({
      entityId: first.entityId,
      revisionId: 'revision-2',
      currentRevision: first.revision,
      expectedRevision: revisionNumber(1),
      value: { text: 'second' },
      createdAt: parseUtcInstant('2026-08-15T11:00:00Z'),
    });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(first.value).toEqual({ text: 'first' });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.value)).toBe(true);
    expect(nextRevision(second.revision)).toBe(3);
  });

  it('rejects stale, missing, and unexpected concurrency preconditions', () => {
    expect(() =>
      assertExpectedRevision(revisionNumber(1), revisionNumber(2)),
    ).toThrow(OptimisticConcurrencyError);
    expect(() =>
      appendRevision({
        entityId: 'entity',
        revisionId: 'revision-2',
        currentRevision: revisionNumber(2),
        value: 'content',
        createdAt: parseUtcInstant('2026-08-15T11:00:00Z'),
      }),
    ).toThrow('requires an expected revision');
    expect(() =>
      appendRevision({
        entityId: 'entity',
        revisionId: 'revision-1',
        expectedRevision: revisionNumber(1),
        value: 'content',
        createdAt: parseUtcInstant('2026-08-15T11:00:00Z'),
      }),
    ).toThrow(OptimisticConcurrencyError);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid revision number %s',
    (value) =>
      expect(() => revisionNumber(value)).toThrow(DomainInvariantError),
  );

  it('accepts a matching expected revision', () => {
    expect(
      assertExpectedRevision(revisionNumber(2), revisionNumber(2)),
    ).toBeUndefined();
  });
});

describe('processing lifecycle state machine (STATE-001, STATE-002, STATE-003, STATE-004)', () => {
  it('supports independent success, insufficiency, failure, cancellation, and staleness paths', () => {
    expect(transitionProcessing('queued', 'running')).toBe('running');
    expect(transitionProcessing('running', 'succeeded')).toBe('succeeded');
    expect(transitionProcessing('succeeded', 'stale')).toBe('stale');
    expect(transitionProcessing('stale', 'superseded')).toBe('superseded');
    expect(transitionProcessing('running', 'insufficient_information')).toBe(
      'insufficient_information',
    );
    expect(transitionProcessing('queued', 'failed')).toBe('failed');
    expect(transitionProcessing('queued', 'canceled')).toBe('canceled');
    expect(canTransitionProcessing('failed', 'superseded')).toBe(true);
  });

  it('rejects regression and retry-in-place because retries are linked new attempts', () => {
    expect(canTransitionProcessing('failed', 'running')).toBe(false);
    expect(() => transitionProcessing('failed', 'running')).toThrow(
      InvalidStateTransitionError,
    );
    expect(() => transitionProcessing('superseded', 'running')).toThrow(
      'Invalid processing lifecycle transition',
    );
  });

  it('identifies only states with no outgoing transition as terminal', () => {
    expect(isTerminalProcessingStatus('superseded')).toBe(true);
    expect(isTerminalProcessingStatus('failed')).toBe(false);
  });
});

describe('required-information lifecycle (NUDGE-002, NUDGE-004, NUDGE-006, NUDGE-007)', () => {
  it('allows nudging only after insufficiency and models user responses explicitly', () => {
    expect(
      transitionRequirementEvaluation(
        'not_evaluated',
        'insufficient_information',
      ),
    ).toBe('insufficient_information');
    expect(
      transitionRequirementEvaluation(
        'insufficient_information',
        'pending_user_response',
      ),
    ).toBe('pending_user_response');
    expect(
      transitionRequirementEvaluation('pending_user_response', 'dismissed'),
    ).toBe('dismissed');
    expect(transitionRequirementEvaluation('dismissed', 'not_evaluated')).toBe(
      'not_evaluated',
    );
  });

  it('keeps technical failure distinct from missing user information', () => {
    expect(transitionRequirementEvaluation('not_evaluated', 'failed')).toBe(
      'failed',
    );
    expect(() =>
      transitionRequirementEvaluation('failed', 'pending_user_response'),
    ).toThrow(InvalidStateTransitionError);
  });
});
