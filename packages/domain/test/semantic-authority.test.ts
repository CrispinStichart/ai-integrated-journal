import { describe, expect, it } from 'vitest';

import {
  DomainInvariantError,
  isKnown,
  known,
  mapKnown,
  neutral,
  none,
  notApplicable,
  resolveEffectiveValue,
  revisionNumber,
  uncertain,
  unknown,
  type SemanticValue,
} from '../src/index.js';

describe('semantic values (SEM-001, SEM-002, SEM-003, SEM-004, SEM-005)', () => {
  it('preserves explicit zero and false as known values rather than absence', () => {
    const zero = known(0);
    const no = known(false);

    expect(zero).toEqual({ state: 'known', value: 0 });
    expect(no).toEqual({ state: 'known', value: false });
    expect(isKnown(zero)).toBe(true);
    expect(zero).not.toEqual(none());
  });

  it('keeps every semantic absence state distinct', () => {
    expect([unknown(), none(), neutral(), notApplicable()]).toEqual([
      { state: 'unknown' },
      { state: 'none' },
      { state: 'neutral' },
      { state: 'not_applicable' },
    ]);
  });

  it('represents uncertainty with optional evidence and bounded confidence', () => {
    expect(uncertain()).toEqual({ state: 'uncertain' });
    expect(uncertain({ value: 'late evening' })).toEqual({
      state: 'uncertain',
      value: 'late evening',
    });
    expect(uncertain({ confidence: 0 })).toEqual({
      state: 'uncertain',
      confidence: 0,
    });
    expect(uncertain({ value: 0, confidence: 1 })).toEqual({
      state: 'uncertain',
      value: 0,
      confidence: 1,
    });
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid confidence %s',
    (confidence) => {
      expect(() => uncertain({ confidence })).toThrow(DomainInvariantError);
    },
  );

  it('maps known and supported uncertain values without coercing semantic states', () => {
    expect(mapKnown(known(2), (value) => value * 3)).toEqual({
      state: 'known',
      value: 6,
    });
    expect(mapKnown(uncertain({ value: 2, confidence: 0.4 }), String)).toEqual({
      state: 'uncertain',
      value: '2',
      confidence: 0.4,
    });
    expect(mapKnown(uncertain<number>({ confidence: 0.4 }), String)).toEqual({
      state: 'uncertain',
      confidence: 0.4,
    });
    const absentNumber: SemanticValue<number> = unknown();
    expect(mapKnown(absentNumber, String)).toEqual({ state: 'unknown' });
    expect(isKnown(unknown())).toBe(false);
  });

  it('round-trips each JSON representation without losing falsy values', () => {
    const values: SemanticValue<unknown>[] = [
      unknown(),
      known(0),
      known(false),
      known(''),
      none(),
      neutral(),
      notApplicable(),
      uncertain({ value: '', confidence: 0.5 }),
    ];

    for (const value of values) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });
});

describe('human/generated authority (ARCH-004, EDIT-006, EDIT-007, TIME-007)', () => {
  it('keeps the newest active manual value over a later generated proposal', () => {
    const selected = resolveEffectiveValue([
      {
        authority: 'manual',
        revision: revisionNumber(2),
        value: 'user correction',
        active: true,
        superseded: false,
      },
      {
        authority: 'generated',
        revision: revisionNumber(10),
        value: 'new AI proposal',
        active: true,
        superseded: false,
      },
      {
        authority: 'manual',
        revision: revisionNumber(1),
        value: 'old correction',
        active: true,
        superseded: false,
      },
    ]);

    expect(selected.value).toBe('user correction');
  });

  it('uses the newest eligible generated candidate when no manual override is active', () => {
    const selected = resolveEffectiveValue([
      {
        authority: 'manual',
        revision: revisionNumber(5),
        value: 'inactive',
        active: false,
        superseded: false,
      },
      {
        authority: 'generated',
        revision: revisionNumber(2),
        value: 'old',
        active: true,
        superseded: false,
      },
      {
        authority: 'generated',
        revision: revisionNumber(3),
        value: 'current',
        active: true,
        superseded: false,
      },
      {
        authority: 'generated',
        revision: revisionNumber(4),
        value: 'superseded',
        active: true,
        superseded: true,
      },
    ]);

    expect(selected.value).toBe('current');
  });

  it('fails visibly when no effective candidate exists', () => {
    expect(() => resolveEffectiveValue([])).toThrow(
      'No active, non-superseded',
    );
  });
});
