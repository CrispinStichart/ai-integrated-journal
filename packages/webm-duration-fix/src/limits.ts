import { NumericOverflowError, ResourceLimitError } from './errors.js';

/**
 * Whole-file repair is an explicitly bounded browser operation. The ceiling is
 * aligned with the application's 128 MiB browser-storage low-space floor.
 */
export const MAX_WEBM_INPUT_BYTES = 128 * 1024 * 1024;

/** Metadata may occupy at most one application audio transport unit. */
export const MAX_WEBM_METADATA_BYTES = 8 * 1024 * 1024;

/** Matroska nesting is shallow in practice; this also bounds parser recursion. */
export const MAX_EBML_NESTING_DEPTH = 32;

/** Bounds parser objects even when an attacker uses zero-length elements. */
export const MAX_EBML_ELEMENT_COUNT = 500_000;

export interface ResourceLimits {
  readonly maximumInputBytes: number;
  readonly maximumMetadataBytes: number;
}

export interface ResourceLimitOptions {
  readonly maximumInputBytes?: number;
  readonly maximumMetadataBytes?: number;
}

function resolveMaximum(
  requested: number | undefined,
  supported: number,
  name: string,
): number {
  if (
    requested !== undefined &&
    (!Number.isSafeInteger(requested) || requested < 0)
  ) {
    throw new NumericOverflowError(
      `${name} must be a non-negative safe integer.`,
    );
  }
  return Math.min(requested ?? supported, supported);
}

export function resolveResourceLimits(
  options: ResourceLimitOptions,
): ResourceLimits {
  return {
    maximumInputBytes: resolveMaximum(
      options.maximumInputBytes,
      MAX_WEBM_INPUT_BYTES,
      'maximumInputBytes',
    ),
    maximumMetadataBytes: resolveMaximum(
      options.maximumMetadataBytes,
      MAX_WEBM_METADATA_BYTES,
      'maximumMetadataBytes',
    ),
  };
}

export function assertBoundedSize(
  actual: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new NumericOverflowError(
      `${label} limit is not a non-negative safe integer.`,
    );
  }
  if (!Number.isSafeInteger(actual) || actual < 0) {
    throw new NumericOverflowError(
      `${label} is not a non-negative safe integer.`,
    );
  }
  if (actual > maximum) {
    throw new ResourceLimitError(
      `${label} contains ${actual} bytes; the operation permits ${maximum}.`,
    );
  }
}
