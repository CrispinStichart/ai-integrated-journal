import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  applyArtifactOverrides,
  assertManualArtifactTargets,
  DomainInvariantError,
  mergeArtifactOverrides,
  parseArtifactJsonPointer,
} from '../src/index.js';

describe('manual artifact editing (ARCH-004, EDIT-005, EDIT-006, EDIT-007)', () => {
  it('[ARCH-004][EDIT-006] applies only explicitly overridden fields and leaves generated input immutable', () => {
    const generated = {
      amount: 1,
      context: { meal: 'breakfast', place: 'home' },
    };
    const effective = applyArtifactOverrides(generated, [
      { path: '/amount', value: 2 },
      { path: '/context/place', value: 'office' },
    ]);
    expect(effective).toEqual({
      amount: 2,
      context: { meal: 'breakfast', place: 'office' },
    });
    expect(generated).toEqual({
      amount: 1,
      context: { meal: 'breakfast', place: 'home' },
    });
  });

  it('[EDIT-006] preserves prior manual paths while a later correction replaces only the addressed path', () => {
    expect(
      mergeArtifactOverrides(
        [
          { path: '/amount', value: 2 },
          { path: '/place', value: 'home' },
        ],
        [{ path: '/amount', value: 3 }],
      ),
    ).toEqual([
      { path: '/amount', value: 3 },
      { path: '/place', value: 'home' },
    ]);
    expect(
      mergeArtifactOverrides(
        [{ path: '', value: { amount: 2, place: 'home' } }],
        [{ path: '/amount', value: 3 }],
      ),
    ).toEqual([{ path: '', value: { amount: 3, place: 'home' } }]);
  });

  it('[ARCH-004][EDIT-006] supports stable JSON Pointer paths inside structured arrays', () => {
    expect(
      applyArtifactOverrides({ items: [{ amount: 1 }, { amount: 2 }] }, [
        { path: '/items/1/amount', value: 4 },
      ]),
    ).toEqual({ items: [{ amount: 1 }, { amount: 4 }] });
    expect(() =>
      applyArtifactOverrides({ items: [{ amount: 1 }] }, [
        { path: '/items/3/amount', value: 4 },
      ]),
    ).toThrow(/existing object or array/);
    expect(() =>
      applyArtifactOverrides({ amount: 1 }, [
        { path: '', value: { amount: 2 } },
        { path: '/amount', value: 3 },
      ]),
    ).toThrow(/cannot be combined/);
  });

  it('[ARCH-004] rejects prototype-polluting, duplicate, and malformed override paths', () => {
    expect(() => parseArtifactJsonPointer('/__proto__/polluted')).toThrow(
      DomainInvariantError,
    );
    expect(() => parseArtifactJsonPointer('amount')).toThrow(
      DomainInvariantError,
    );
    expect(() =>
      applyArtifactOverrides({}, [
        { path: '/x', value: 1 },
        { path: '/x', value: 2 },
      ]),
    ).toThrow(/only once/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('[ARCH-004][EDIT-006] decodes escaped JSON Pointer segments and rejects empty path segments', () => {
    const root = parseArtifactJsonPointer('');
    expect(root).toEqual([]);
    expect(Object.isFrozen(root)).toBe(true);
    expect(parseArtifactJsonPointer('/a~1b/~0value')).toEqual([
      'a/b',
      '~value',
    ]);
    expect(() => parseArtifactJsonPointer('/items//amount')).toThrow(
      /empty segment/,
    );
  });

  it('[ARCH-004][EDIT-006] accepts an object as a whole-artifact correction and rejects non-object replacements', () => {
    expect(
      applyArtifactOverrides({ stale: true }, [
        { path: '', value: { corrected: true } },
      ]),
    ).toEqual({ corrected: true });

    for (const invalid of [null, 'text', ['array']]) {
      expect(() =>
        applyArtifactOverrides({ stable: true }, [
          { path: '', value: invalid },
        ]),
      ).toThrow(/must be a JSON object/);
    }
  });

  it('[ARCH-004][EDIT-006] replaces existing array items only by canonical numeric index', () => {
    expect(
      applyArtifactOverrides({ items: ['old', 'stable'] }, [
        { path: '/items/0', value: 'corrected' },
      ]),
    ).toEqual({ items: ['corrected', 'stable'] });
    expect(() =>
      applyArtifactOverrides({ items: ['old'] }, [
        { path: '/items/01', value: 'ambiguous' },
      ]),
    ).toThrow(/numeric index/);
    expect(() =>
      applyArtifactOverrides({ items: ['old'] }, [
        { path: '/items/1', value: 'missing' },
      ]),
    ).toThrow(/existing item/);
  });

  it('[ARCH-004][EDIT-006] creates missing object parents without traversing through invalid array positions', () => {
    expect(
      applyArtifactOverrides({ context: 'unknown' }, [
        { path: '/context/place', value: 'home' },
      ]),
    ).toEqual({ context: { place: 'home' } });
    expect(() =>
      applyArtifactOverrides({ items: [null] }, [
        { path: '/items/0/place', value: 'home' },
      ]),
    ).toThrow(/existing object or array/);
  });

  it('[ARCH-004][EDIT-006] rejects malformed stored whole-artifact authority and lets a new whole override supersede field paths', () => {
    for (const invalid of [null, 3, ['array']]) {
      expect(() =>
        mergeArtifactOverrides(
          [{ path: '', value: invalid }],
          [{ path: '/amount', value: 3 }],
        ),
      ).toThrow(/stored whole-artifact override/);
    }
    expect(
      mergeArtifactOverrides(
        [{ path: '/amount', value: 2 }],
        [{ path: '', value: { amount: 3, place: 'home' } }],
      ),
    ).toEqual([{ path: '', value: { amount: 3, place: 'home' } }]);
  });

  it('[FOOD-007] validates split and merge cardinality and unique source identity', () => {
    expect(() =>
      assertManualArtifactTargets({
        operation: 'split',
        sourceArtifactIds: ['a'],
        resultCount: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertManualArtifactTargets({
        operation: 'merge',
        sourceArtifactIds: ['a', 'b'],
        resultCount: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertManualArtifactTargets({
        operation: 'split',
        sourceArtifactIds: ['a'],
        resultCount: 1,
      }),
    ).toThrow(/split/);
    expect(() =>
      assertManualArtifactTargets({
        operation: 'merge',
        sourceArtifactIds: ['a', 'a'],
        resultCount: 1,
      }),
    ).toThrow(/unique/);
    expect(() =>
      assertManualArtifactTargets({
        operation: 'merge',
        sourceArtifactIds: ['a'],
        resultCount: 1,
      }),
    ).toThrow(/merge/);
    expect(() =>
      assertManualArtifactTargets({
        operation: 'merge',
        sourceArtifactIds: ['a', 'b'],
        resultCount: 2,
      }),
    ).toThrow(/merge/);
  });

  it('[EDIT-006] property: applying one scalar manual override always preserves unrelated generated fields', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (manual, generated) => {
        const effective = applyArtifactOverrides(
          { generated, untouched: 'stable' },
          [{ path: '/generated', value: manual }],
        );
        expect(effective).toEqual({ generated: manual, untouched: 'stable' });
      }),
    );
  });
});
