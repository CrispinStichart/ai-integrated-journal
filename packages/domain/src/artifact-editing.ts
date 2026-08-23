import { DomainInvariantError } from './errors.js';

export type ArtifactManualOperation =
  | 'confirm'
  | 'correct'
  | 'delete'
  | 'merge_result'
  | 'merge_source'
  | 'split_result'
  | 'split_source';

export interface ArtifactOverrideValue {
  readonly path: string;
  readonly value: unknown;
}

const FORBIDDEN_POINTER_SEGMENTS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export function parseArtifactJsonPointer(path: string): readonly string[] {
  if (path === '') return Object.freeze([]);
  if (!path.startsWith('/'))
    throw new DomainInvariantError(
      'An artifact override path must be a JSON Pointer.',
    );
  const segments = path
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (segments.some((segment) => FORBIDDEN_POINTER_SEGMENTS.has(segment)))
    throw new DomainInvariantError(
      'An artifact override path contains a forbidden segment.',
    );
  if (segments.some((segment) => segment.length === 0))
    throw new DomainInvariantError(
      'An artifact override path cannot contain an empty segment.',
    );
  return Object.freeze(segments);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

/** Applies field-granular manual authority without mutating either input. */
export function applyArtifactOverrides(
  generated: Readonly<Record<string, unknown>>,
  overrides: readonly ArtifactOverrideValue[],
): Readonly<Record<string, unknown>> {
  if (overrides.length > 1 && overrides.some(({ path }) => path === ''))
    throw new DomainInvariantError(
      'A whole-artifact override cannot be combined with field overrides.',
    );
  const output = cloneJson(generated);
  const seen = new Set<string>();
  for (const override of overrides) {
    if (seen.has(override.path))
      throw new DomainInvariantError(
        'An artifact override path may appear only once.',
      );
    seen.add(override.path);
    const segments = parseArtifactJsonPointer(override.path);
    if (segments.length === 0) {
      if (
        override.value === null ||
        typeof override.value !== 'object' ||
        Array.isArray(override.value)
      )
        throw new DomainInvariantError(
          'A whole-artifact override must be a JSON object.',
        );
      return Object.freeze(
        cloneJson(override.value as Record<string, unknown>),
      );
    }
    let cursor: Record<string, unknown> | unknown[] = output;
    for (const [index, segment] of segments.entries()) {
      if (index === segments.length - 1) {
        if (Array.isArray(cursor)) {
          if (!/^(?:0|[1-9]\d*)$/.test(segment))
            throw new DomainInvariantError(
              'An array override path must use a numeric index.',
            );
          const arrayIndex = Number(segment);
          if (arrayIndex >= cursor.length)
            throw new DomainInvariantError(
              'An array override index must address an existing item.',
            );
          cursor[arrayIndex] = cloneJson(override.value);
        } else {
          cursor[segment] = cloneJson(override.value);
        }
        continue;
      }
      const child: unknown = Array.isArray(cursor)
        ? cursor[Number(segment)]
        : cursor[segment];
      if (child === null || typeof child !== 'object' || Array.isArray(child)) {
        if (Array.isArray(child)) {
          cursor = child;
          continue;
        }
        if (Array.isArray(cursor))
          throw new DomainInvariantError(
            'An array override path must address an existing object or array.',
          );
        cursor[segment] = {};
      }
      cursor = (
        Array.isArray(cursor) ? cursor[Number(segment)] : cursor[segment]
      ) as Record<string, unknown> | unknown[];
    }
  }
  return Object.freeze(output);
}

export function mergeArtifactOverrides(
  previous: readonly ArtifactOverrideValue[],
  next: readonly ArtifactOverrideValue[],
): readonly ArtifactOverrideValue[] {
  const previousWhole = previous.find(({ path }) => path === '');
  if (previousWhole !== undefined) {
    if (
      previousWhole.value === null ||
      typeof previousWhole.value !== 'object' ||
      Array.isArray(previousWhole.value)
    )
      throw new DomainInvariantError(
        'A stored whole-artifact override must be a JSON object.',
      );
    return Object.freeze([
      Object.freeze({
        path: '',
        value: applyArtifactOverrides(
          previousWhole.value as Readonly<Record<string, unknown>>,
          next,
        ),
      }),
    ]);
  }
  const byPath = new Map(previous.map((item) => [item.path, item]));
  for (const item of next) {
    parseArtifactJsonPointer(item.path);
    byPath.set(
      item.path,
      Object.freeze({ path: item.path, value: cloneJson(item.value) }),
    );
  }
  const wholeArtifact = byPath.get('');
  if (wholeArtifact !== undefined) return Object.freeze([wholeArtifact]);
  return Object.freeze(
    [...byPath.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  );
}

export function assertManualArtifactTargets(input: {
  readonly operation: 'merge' | 'split';
  readonly sourceArtifactIds: readonly string[];
  readonly resultCount: number;
}): void {
  if (new Set(input.sourceArtifactIds).size !== input.sourceArtifactIds.length)
    throw new DomainInvariantError(
      'Manual artifact edit sources must be unique.',
    );
  if (input.operation === 'split') {
    if (input.sourceArtifactIds.length !== 1 || input.resultCount < 2)
      throw new DomainInvariantError(
        'A split requires one source and at least two results.',
      );
  } else if (input.sourceArtifactIds.length < 2 || input.resultCount !== 1) {
    throw new DomainInvariantError(
      'A merge requires at least two sources and one result.',
    );
  }
}
