import { NumericOverflowError, ResourceLimitError } from './errors.js';
import { finalizeContainer } from './finalizer.js';
import { parseWebm } from './parser.js';

export interface FinalizedWebmBytes {
  readonly bytes: Uint8Array;
  readonly changed: boolean;
}

/** Caller-owned policy. Task 5 will select application limits and test their boundaries. */
export interface FinalizeWebmOptions {
  readonly maximumInputBytes?: number;
}

export function assertInputSize(
  inputBytes: number,
  options: FinalizeWebmOptions,
): void {
  const maximum = options.maximumInputBytes;
  if (
    maximum !== undefined &&
    (!Number.isSafeInteger(maximum) || maximum < 0)
  ) {
    throw new NumericOverflowError(
      'maximumInputBytes must be a non-negative safe integer.',
    );
  }
  if (maximum !== undefined && inputBytes > maximum) {
    throw new ResourceLimitError(
      `WebM input contains ${inputBytes} bytes; the caller permits ${maximum}.`,
    );
  }
}

/** Validates that bytes contain an EBML header declaring a WebM Segment. */
export function assertWebmContainer(bytes: Uint8Array): void {
  parseWebm(bytes);
}

/** Platform-neutral WebM duration repair. Encoded cluster bytes are retained verbatim. */
export async function finalizeWebmBytes(
  input: Uint8Array,
  options: FinalizeWebmOptions = {},
): Promise<FinalizedWebmBytes> {
  assertInputSize(input.byteLength, options);
  return finalizeContainer(input);
}
