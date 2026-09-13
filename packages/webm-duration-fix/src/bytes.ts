import {
  InvalidEbmlError,
  NumericOverflowError,
  TruncatedDataError,
} from './errors.js';
import { assertBoundedSize } from './limits.js';

export interface VariableInteger {
  readonly length: number;
  readonly unknown: boolean;
  readonly value: number;
}

export function concatBytes(
  parts: readonly Uint8Array[],
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  assertBoundedSize(length, maximumBytes, 'Combined output');
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function vintLength(first: number, label: string): number {
  if (first === 0) {
    throw new InvalidEbmlError(`EBML ${label} starts with a zero byte.`);
  }
  return Math.clz32(first) - 24 + 1;
}

function assertReadableOffset(
  bytes: Uint8Array,
  offset: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > bytes.byteLength
  ) {
    throw new InvalidEbmlError(`EBML ${label} has an impossible offset.`);
  }
}

export function readElementId(
  bytes: Uint8Array,
  offset: number,
): VariableInteger {
  assertReadableOffset(bytes, offset, 'element ID');
  const first = bytes[offset];
  if (first === undefined) {
    throw new TruncatedDataError('WebM input ends inside an element ID.');
  }
  const length = vintLength(first, 'element ID');
  if (length > 4) {
    throw new InvalidEbmlError('EBML element IDs cannot exceed four bytes.');
  }
  if (offset + length > bytes.byteLength) {
    throw new TruncatedDataError('WebM input ends inside an element ID.');
  }
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined)
      throw new TruncatedDataError('WebM input ends inside an element ID.');
    value = value * 256 + byte;
  }
  return { length, unknown: false, value };
}

export function readElementSize(
  bytes: Uint8Array,
  offset: number,
): VariableInteger {
  assertReadableOffset(bytes, offset, 'element size');
  const first = bytes[offset];
  if (first === undefined) {
    throw new TruncatedDataError('WebM input ends inside an element size.');
  }
  const length = vintLength(first, 'element size');
  if (length > 8) {
    throw new InvalidEbmlError('EBML element sizes cannot exceed eight bytes.');
  }
  if (offset + length > bytes.byteLength) {
    throw new TruncatedDataError('WebM input ends inside an element size.');
  }
  let value = first & (0xff >> length);
  let unknown = value === 0xff >> length;
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined)
      throw new TruncatedDataError('WebM input ends inside an element size.');
    value = value * 256 + byte;
    unknown = unknown && byte === 0xff;
    if (!Number.isSafeInteger(value)) {
      if (unknown) continue;
      throw new NumericOverflowError(
        'EBML element size exceeds the safe integer range.',
      );
    }
  }
  return { length, unknown, value };
}

export function writeVariableSize(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NumericOverflowError(
      'EBML element size must be a non-negative safe integer.',
    );
  }
  for (let length = 1; length <= 8; length += 1) {
    if (value < 2 ** (7 * length) - 1) {
      const result = new Uint8Array(length);
      let remaining = value;
      for (let index = length - 1; index >= 0; index -= 1) {
        result[index] = remaining % 256;
        remaining = Math.floor(remaining / 256);
      }
      result[0] = (result[0] ?? 0) | (1 << (8 - length));
      return result;
    }
  }
  throw new NumericOverflowError('EBML element size cannot be represented.');
}

export function encodeUnsigned(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NumericOverflowError(
      'EBML unsigned integer must be a non-negative safe integer.',
    );
  }
  let width = 1;
  while (value >= 2 ** (8 * width)) width += 1;
  if (width > 7) {
    throw new NumericOverflowError(
      'EBML unsigned integer exceeds the safe integer range.',
    );
  }
  const result = new Uint8Array(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    result[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return result;
}

export function decodeUnsigned(bytes: Uint8Array): number {
  if (bytes.byteLength === 0 || bytes.byteLength > 7) {
    throw new NumericOverflowError(
      'EBML unsigned integer has an unsupported width.',
    );
  }
  let result = 0;
  for (const byte of bytes) {
    result = result * 256 + byte;
    if (!Number.isSafeInteger(result)) {
      throw new NumericOverflowError(
        'EBML unsigned integer exceeds the safe integer range.',
      );
    }
  }
  return result;
}

export function encodeFloat64(value: number): Uint8Array {
  if (!Number.isFinite(value)) {
    throw new NumericOverflowError('WebM duration must be finite.');
  }
  const result = new Uint8Array(8);
  new DataView(result.buffer).setFloat64(0, value);
  return result;
}
