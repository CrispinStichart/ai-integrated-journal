import { DomainInvariantError } from './errors.js';

export const EVIDENCE_NORMALIZATION = 'NFC_LF_V1' as const;
export const EVIDENCE_OFFSET_UNIT = 'utf16_code_unit' as const;

export type EvidenceResolutionStatus = 'resolved' | 'unresolved' | 'stale';

export type TextEvidenceCoordinates = Readonly<{
  normalization: typeof EVIDENCE_NORMALIZATION;
  offsetUnit: typeof EVIDENCE_OFFSET_UNIT;
  startUtf16: number;
  endUtf16: number;
  quote: string;
}>;

export type AudioEvidenceRange = Readonly<{
  startMs: number;
  endMs: number;
}>;

function assertWellFormed(value: string): void {
  if (!value.isWellFormed()) {
    throw new DomainInvariantError(
      'Evidence text must contain only well-formed Unicode scalar values.',
    );
  }
}

/** Applies the immutable evidence coordinate contract from ADR-0009. */
export function normalizeEvidenceText(value: string): string {
  assertWellFormed(value);
  const normalized = value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .normalize('NFC');
  assertWellFormed(normalized);
  return normalized;
}

export function isUtf16Boundary(value: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) {
    return false;
  }
  if (offset === 0 || offset === value.length) return true;
  const before = value.charCodeAt(offset - 1);
  const after = value.charCodeAt(offset);
  return !(
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  );
}

export function textEvidenceCoordinates(input: {
  readonly evidenceText: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
}): TextEvidenceCoordinates {
  const evidenceText = normalizeEvidenceText(input.evidenceText);
  if (
    !Number.isSafeInteger(input.startUtf16) ||
    !Number.isSafeInteger(input.endUtf16) ||
    input.startUtf16 < 0 ||
    input.startUtf16 >= input.endUtf16 ||
    input.endUtf16 > evidenceText.length
  ) {
    throw new DomainInvariantError(
      'Evidence offsets must describe a non-empty, end-exclusive UTF-16 range.',
    );
  }
  if (
    !isUtf16Boundary(evidenceText, input.startUtf16) ||
    !isUtf16Boundary(evidenceText, input.endUtf16)
  ) {
    throw new DomainInvariantError(
      'Evidence offsets must not split a UTF-16 surrogate pair.',
    );
  }
  return Object.freeze({
    normalization: EVIDENCE_NORMALIZATION,
    offsetUnit: EVIDENCE_OFFSET_UNIT,
    startUtf16: input.startUtf16,
    endUtf16: input.endUtf16,
    quote: evidenceText.slice(input.startUtf16, input.endUtf16),
  });
}

export function audioEvidenceRange(
  startMs: number,
  endMs: number,
): AudioEvidenceRange {
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    startMs < 0 ||
    startMs >= endMs
  ) {
    throw new DomainInvariantError(
      'Audio evidence must use a non-empty, end-exclusive millisecond range.',
    );
  }
  return Object.freeze({ startMs, endMs });
}

export type LocatedTranscriptSegment<Id extends string = string> = Readonly<{
  id: Id;
  ordinal: number;
  startUtf16: number;
  endUtf16: number;
  quote: string;
  audioRange?: AudioEvidenceRange;
}>;

/**
 * Locates provider segments in order without changing provider wording. Gaps
 * are permitted, but ambiguous or non-matching segments fail explicitly.
 */
export function locateTranscriptSegments<Id extends string>(input: {
  readonly evidenceText: string;
  readonly segments: readonly Readonly<{
    id: Id;
    text: string;
    audioRange?: Readonly<{ startMs: number; endMs: number }>;
  }>[];
}): readonly LocatedTranscriptSegment<Id>[] {
  const evidenceText = normalizeEvidenceText(input.evidenceText);
  let cursor = 0;
  return Object.freeze(
    input.segments.map((segment, ordinal) => {
      const quote = normalizeEvidenceText(segment.text);
      if (quote.length === 0) {
        throw new DomainInvariantError('Transcript segments cannot be empty.');
      }
      const startUtf16 = evidenceText.indexOf(quote, cursor);
      if (startUtf16 < 0) {
        throw new DomainInvariantError(
          'Transcript segment text must resolve in order within its revision.',
        );
      }
      const coordinates = textEvidenceCoordinates({
        evidenceText,
        startUtf16,
        endUtf16: startUtf16 + quote.length,
      });
      cursor = coordinates.endUtf16;
      return Object.freeze({
        id: segment.id,
        ordinal,
        startUtf16: coordinates.startUtf16,
        endUtf16: coordinates.endUtf16,
        quote: coordinates.quote,
        ...(segment.audioRange === undefined
          ? {}
          : {
              audioRange: audioEvidenceRange(
                segment.audioRange.startMs,
                segment.audioRange.endMs,
              ),
            }),
      });
    }),
  );
}
