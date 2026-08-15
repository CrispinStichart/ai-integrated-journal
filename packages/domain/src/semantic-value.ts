import { DomainInvariantError } from './errors.js';

export type SemanticValue<T> =
  | { readonly state: 'unknown' }
  | { readonly state: 'known'; readonly value: T }
  | { readonly state: 'none' }
  | { readonly state: 'neutral' }
  | { readonly state: 'not_applicable' }
  | {
      readonly state: 'uncertain';
      readonly value?: T;
      readonly confidence?: number;
    };

export const unknown = (): SemanticValue<never> =>
  Object.freeze({ state: 'unknown' });
export const known = <T>(value: T): SemanticValue<T> =>
  Object.freeze({ state: 'known', value });
export const none = (): SemanticValue<never> =>
  Object.freeze({ state: 'none' });
export const neutral = (): SemanticValue<never> =>
  Object.freeze({ state: 'neutral' });
export const notApplicable = (): SemanticValue<never> =>
  Object.freeze({ state: 'not_applicable' });

export interface UncertainOptions<T> {
  readonly value?: T;
  readonly confidence?: number;
}

export function uncertain<T>(
  options: UncertainOptions<T> = {},
): SemanticValue<T> {
  if (
    options.confidence !== undefined &&
    (!Number.isFinite(options.confidence) ||
      options.confidence < 0 ||
      options.confidence > 1)
  ) {
    throw new DomainInvariantError(
      'Uncertain confidence must be a finite number from 0 through 1.',
    );
  }

  return Object.freeze({
    state: 'uncertain' as const,
    ...(options.value === undefined ? {} : { value: options.value }),
    ...(options.confidence === undefined
      ? {}
      : { confidence: options.confidence }),
  });
}

export function isKnown<T>(
  value: SemanticValue<T>,
): value is { state: 'known'; value: T } {
  return value.state === 'known';
}

export function mapKnown<T, Result>(
  value: SemanticValue<T>,
  mapper: (knownValue: T) => Result,
): SemanticValue<Result> {
  if (value.state === 'known') {
    return known(mapper(value.value));
  }
  if (value.state === 'uncertain' && value.value !== undefined) {
    return uncertain({
      value: mapper(value.value),
      ...(value.confidence === undefined
        ? {}
        : { confidence: value.confidence }),
    });
  }
  return value as SemanticValue<Result>;
}
