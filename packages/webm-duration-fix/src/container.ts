import { finalizeContainer } from './finalizer.js';
import {
  assertBoundedSize,
  resolveResourceLimits,
  type ResourceLimitOptions,
} from './limits.js';
import { parseWebm } from './parser.js';

export interface FinalizedWebmBytes {
  readonly bytes: Uint8Array;
  readonly changed: boolean;
}

/** Callers may tighten, but cannot raise, the package's hard resource limits. */
export type FinalizeWebmOptions = ResourceLimitOptions;

export function assertInputSize(
  inputBytes: number,
  options: FinalizeWebmOptions,
): void {
  const limits = resolveResourceLimits(options);
  assertBoundedSize(inputBytes, limits.maximumInputBytes, 'WebM input');
}

/** Validates that bytes contain an EBML header declaring a WebM Segment. */
export function assertWebmContainer(
  bytes: Uint8Array,
  options: FinalizeWebmOptions = {},
): void {
  const limits = resolveResourceLimits(options);
  assertBoundedSize(bytes.byteLength, limits.maximumInputBytes, 'WebM input');
  parseWebm(bytes, { maximumMetadataBytes: limits.maximumMetadataBytes });
}

/** Platform-neutral WebM duration repair. Encoded cluster bytes are retained verbatim. */
export async function finalizeWebmBytes(
  input: Uint8Array,
  options: FinalizeWebmOptions = {},
): Promise<FinalizedWebmBytes> {
  const limits = resolveResourceLimits(options);
  assertBoundedSize(input.byteLength, limits.maximumInputBytes, 'WebM input');
  return finalizeContainer(input, limits);
}
