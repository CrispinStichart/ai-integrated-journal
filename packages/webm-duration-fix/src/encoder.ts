import {
  concatBytes,
  encodeFloat64,
  encodeUnsigned,
  writeVariableSize,
} from './bytes.js';
import { InvalidEbmlError } from './errors.js';
import { MAX_WEBM_METADATA_BYTES } from './limits.js';
import { WEBM_IDS, type EbmlElement } from './ebml.js';

export interface EncodedElement {
  readonly bytes: Uint8Array;
  readonly id: number;
}

export function idBytes(id: number): Uint8Array {
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new InvalidEbmlError('Invalid EBML element ID.');
  const values: number[] = [];
  let remaining = id;
  while (remaining > 0) {
    values.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  if (values.length > 4 || (values[0] ?? 0) === 0) {
    throw new InvalidEbmlError('EBML element IDs cannot exceed four bytes.');
  }
  return Uint8Array.from(values);
}

export function encodeElement(
  id: number,
  data: Uint8Array,
  maximumBytes = MAX_WEBM_METADATA_BYTES,
): Uint8Array {
  return concatBytes(
    [idBytes(id), writeVariableSize(data.byteLength), data],
    maximumBytes,
  );
}

export function encodeMaster(
  id: number,
  children: readonly Uint8Array[],
  maximumBytes = MAX_WEBM_METADATA_BYTES,
): Uint8Array {
  return encodeElement(id, concatBytes(children, maximumBytes), maximumBytes);
}

export function encodeUnknownSizeMaster(id: number): Uint8Array {
  return concatBytes([
    idBytes(id),
    Uint8Array.from([1, 255, 255, 255, 255, 255, 255, 255]),
  ]);
}

export function copyElement(element: EbmlElement): Uint8Array {
  return concatBytes(
    [element.idBytes, element.sizeBytes, element.data],
    MAX_WEBM_METADATA_BYTES,
  );
}

export function encodeDuration(duration: number): Uint8Array {
  return encodeElement(WEBM_IDS.duration, encodeFloat64(duration));
}

export function encodeUnsignedElement(id: number, value: number): Uint8Array {
  return encodeElement(id, encodeUnsigned(value));
}
