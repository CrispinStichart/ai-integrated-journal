import { readElementId, readElementSize } from './bytes.js';
import {
  InvalidEbmlError,
  ResourceLimitError,
  TruncatedDataError,
  UnsupportedWebmInputError,
} from './errors.js';
import {
  MAX_EBML_ELEMENT_COUNT,
  MAX_EBML_NESTING_DEPTH,
  MAX_WEBM_METADATA_BYTES,
  assertBoundedSize,
} from './limits.js';
import {
  MASTER_ELEMENT_IDS,
  WEBM_IDS,
  type EbmlElement,
  type ParsedWebm,
} from './ebml.js';

interface ParseBudget {
  elements: number;
  readonly maximumElements: number;
  readonly maximumNestingDepth: number;
}

export interface ParserOptions {
  readonly maximumElements?: number;
  readonly maximumMetadataBytes?: number;
  readonly maximumNestingDepth?: number;
}

function parseRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  depth: number,
  budget: ParseBudget,
): readonly EbmlElement[] {
  if (depth > budget.maximumNestingDepth) {
    throw new ResourceLimitError(
      `EBML nesting exceeds ${budget.maximumNestingDepth} levels.`,
    );
  }
  const elements: EbmlElement[] = [];
  let offset = start;
  while (offset < end) {
    budget.elements += 1;
    if (budget.elements > budget.maximumElements) {
      throw new ResourceLimitError(
        `EBML tree exceeds ${budget.maximumElements} elements.`,
      );
    }
    const id = readElementId(bytes, offset);
    const sizeOffset = offset + id.length;
    const size = readElementSize(bytes, sizeOffset);
    const dataStart = sizeOffset + size.length;
    if (size.unknown && !MASTER_ELEMENT_IDS.has(id.value)) {
      throw new InvalidEbmlError(
        'An unknown EBML element size is only valid for a master element.',
      );
    }
    const dataEnd = size.unknown
      ? id.value === WEBM_IDS.cluster
        ? findNextCluster(bytes, dataStart, end)
        : end
      : dataStart + size.value;
    if (!Number.isSafeInteger(dataEnd) || dataEnd < dataStart) {
      throw new InvalidEbmlError('EBML element has an impossible byte range.');
    }
    if (dataEnd <= offset) {
      throw new InvalidEbmlError('EBML element does not advance the parser.');
    }
    if (dataEnd > end) {
      throw new TruncatedDataError('WebM input ends inside element data.');
    }
    const data = bytes.subarray(dataStart, dataEnd);
    const children = MASTER_ELEMENT_IDS.has(id.value)
      ? parseRange(bytes, dataStart, dataEnd, depth + 1, budget)
      : undefined;
    elements.push({
      ...(children === undefined ? {} : { children }),
      data,
      dataEnd,
      dataStart,
      id: id.value,
      idBytes: bytes.subarray(offset, sizeOffset),
      sizeBytes: bytes.subarray(sizeOffset, dataStart),
      tagStart: offset,
      unknownSize: size.unknown,
    });
    offset = dataEnd;
    if (size.unknown && id.value !== WEBM_IDS.cluster) break;
  }
  if (offset !== end) {
    throw new InvalidEbmlError('EBML elements do not fill their parent range.');
  }
  return elements;
}

function findNextCluster(
  bytes: Uint8Array,
  start: number,
  end: number,
): number {
  let offset = start;
  while (offset < end) {
    const id = readElementId(bytes, offset);
    if (id.value === WEBM_IDS.cluster) return offset;
    const sizeOffset = offset + id.length;
    const size = readElementSize(bytes, sizeOffset);
    const dataStart = sizeOffset + size.length;
    if (size.unknown) return end;
    const next = dataStart + size.value;
    if (!Number.isSafeInteger(next) || next <= offset || next > end) {
      throw new TruncatedDataError(
        'WebM input ends inside an unknown-size Cluster.',
      );
    }
    offset = next;
  }
  return end;
}

function child(element: EbmlElement, id: number): EbmlElement | undefined {
  return element.children?.find((candidate) => candidate.id === id);
}

export function parseWebm(
  bytes: Uint8Array,
  options: ParserOptions = {},
): ParsedWebm {
  const maximumElements = options.maximumElements ?? MAX_EBML_ELEMENT_COUNT;
  const maximumMetadataBytes =
    options.maximumMetadataBytes ?? MAX_WEBM_METADATA_BYTES;
  const maximumNestingDepth =
    options.maximumNestingDepth ?? MAX_EBML_NESTING_DEPTH;
  if (
    !Number.isSafeInteger(maximumElements) ||
    maximumElements < 0 ||
    !Number.isSafeInteger(maximumMetadataBytes) ||
    maximumMetadataBytes < 0 ||
    !Number.isSafeInteger(maximumNestingDepth) ||
    maximumNestingDepth < 0
  ) {
    throw new InvalidEbmlError(
      'EBML parser limits must be non-negative integers.',
    );
  }
  const roots = parseRange(bytes, 0, bytes.byteLength, 1, {
    elements: 0,
    maximumElements: Math.min(maximumElements, MAX_EBML_ELEMENT_COUNT),
    maximumNestingDepth: Math.min(maximumNestingDepth, MAX_EBML_NESTING_DEPTH),
  });
  const header = roots[0];
  const segment = roots[1];
  if (header?.id !== WEBM_IDS.ebml) {
    throw new UnsupportedWebmInputError('Input is not an EBML document.');
  }
  assertBoundedSize(
    header.dataEnd - header.tagStart,
    Math.min(maximumMetadataBytes, MAX_WEBM_METADATA_BYTES),
    'WebM EBML header',
  );
  const docType = child(header, WEBM_IDS.docType);
  const declaredType =
    docType === undefined ? '' : new TextDecoder('ascii').decode(docType.data);
  if (declaredType !== 'webm') {
    throw new UnsupportedWebmInputError(
      'EBML document does not declare the WebM document type.',
    );
  }
  if (segment?.id !== WEBM_IDS.segment) {
    throw new InvalidEbmlError(
      'WebM document has no Segment after its EBML header.',
    );
  }
  return { bytes, header, segment };
}
