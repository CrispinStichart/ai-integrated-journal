const EBML_HEADER_ID = 0x1a45dfa3;
const DOC_TYPE_ID = 0x4282;
const MAX_VINT_BYTES = 8;

export interface FinalizedWebmBytes {
  readonly bytes: Uint8Array;
  readonly changed: boolean;
}

export type WebmContainerFinalizer = (
  bytes: Uint8Array,
) => FinalizedWebmBytes | Promise<FinalizedWebmBytes>;

interface ElementHeader {
  readonly dataOffset: number;
  readonly id: number;
  readonly size: number;
}

interface VariableInteger {
  readonly length: number;
  readonly value: number;
}

function readElementId(bytes: Uint8Array, offset: number): VariableInteger {
  const first = bytes[offset];
  if (first === undefined || first === 0) {
    throw new TypeError('WebM input has an invalid or truncated element ID.');
  }

  const length = Math.clz32(first) - 24 + 1;
  if (length > 4 || offset + length > bytes.byteLength) {
    throw new TypeError('WebM input has an invalid or truncated element ID.');
  }

  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
  }
  return { length, value };
}

function readElementSize(bytes: Uint8Array, offset: number): VariableInteger {
  const first = bytes[offset];
  if (first === undefined || first === 0) {
    throw new TypeError('WebM input has an invalid or truncated element size.');
  }

  const length = Math.clz32(first) - 24 + 1;
  if (length > MAX_VINT_BYTES || offset + length > bytes.byteLength) {
    throw new TypeError('WebM input has an invalid or truncated element size.');
  }

  let value = first & (0xff >> length);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('WebM element size exceeds the safe integer range.');
  }
  return { length, value };
}

function readElementHeader(bytes: Uint8Array, offset: number): ElementHeader {
  const id = readElementId(bytes, offset);
  const size = readElementSize(bytes, offset + id.length);
  const dataOffset = offset + id.length + size.length;
  if (size.value > bytes.byteLength - dataOffset) {
    throw new TypeError('WebM input contains a truncated element.');
  }
  return { dataOffset, id: id.value, size: size.value };
}

function decodeAscii(bytes: Uint8Array, start: number, end: number): string {
  let value = '';
  for (let offset = start; offset < end; offset += 1) {
    const byte = bytes[offset];
    if (byte === undefined || byte > 0x7f) return '';
    value += String.fromCharCode(byte);
  }
  return value;
}

/**
 * Performs the small amount of container parsing needed by the public boundary.
 * The duration-repair implementation is deliberately supplied separately.
 */
export function assertWebmContainer(bytes: Uint8Array): void {
  const header = readElementHeader(bytes, 0);
  if (header.id !== EBML_HEADER_ID) {
    throw new TypeError('Input is not an EBML document.');
  }

  const headerEnd = header.dataOffset + header.size;
  let offset = header.dataOffset;
  while (offset < headerEnd) {
    const child = readElementHeader(bytes, offset);
    const childEnd = child.dataOffset + child.size;
    if (child.id === DOC_TYPE_ID) {
      if (decodeAscii(bytes, child.dataOffset, childEnd) !== 'webm') {
        throw new TypeError('EBML document is not a WebM container.');
      }
      return;
    }
    offset = childEnd;
  }

  throw new TypeError('EBML header does not declare the WebM document type.');
}

export async function finalizeWebmBytes(
  input: Uint8Array,
  finalizeContainer: WebmContainerFinalizer,
): Promise<FinalizedWebmBytes> {
  assertWebmContainer(input);
  const result = await finalizeContainer(input);
  assertWebmContainer(result.bytes);
  return result;
}
