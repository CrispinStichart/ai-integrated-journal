import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_NORMALIZATION,
  EVIDENCE_OFFSET_UNIT,
  audioEvidenceRange,
  isUtf16Boundary,
  locateTranscriptSegments,
  normalizeEvidenceText,
  textEvidenceCoordinates,
} from '../src/index.js';

describe('transcript evidence coordinates', () => {
  it('[PROV-003] normalizes only line endings and Unicode NFC', () => {
    expect(normalizeEvidenceText('Cafe\u0301\r\n  Journal\rEntry')).toBe(
      'Café\n  Journal\nEntry',
    );
    expect(() => normalizeEvidenceText('\ud800')).toThrowError(
      /well-formed Unicode/,
    );
  });

  it('[PROV-001][PROV-003] uses non-empty end-exclusive UTF-16 offsets without splitting surrogate pairs', () => {
    const evidenceText = 'A 😊 journal';
    expect(isUtf16Boundary(evidenceText, 3)).toBe(false);
    expect(
      textEvidenceCoordinates({ evidenceText, startUtf16: 2, endUtf16: 4 }),
    ).toEqual({
      normalization: EVIDENCE_NORMALIZATION,
      offsetUnit: EVIDENCE_OFFSET_UNIT,
      startUtf16: 2,
      endUtf16: 4,
      quote: '😊',
    });
    expect(() =>
      textEvidenceCoordinates({ evidenceText, startUtf16: 3, endUtf16: 4 }),
    ).toThrowError(/surrogate pair/);
    expect(() =>
      textEvidenceCoordinates({ evidenceText, startUtf16: 2, endUtf16: 2 }),
    ).toThrowError(/non-empty/);
  });

  it('[DATA-027][DATA-028][AC-012] locates stable segments with optional exact audio ranges', () => {
    expect(
      locateTranscriptSegments({
        evidenceText: 'First.  Second.',
        segments: [
          {
            id: 'segment-1',
            text: 'First.',
            audioRange: { startMs: 0, endMs: 500 },
          },
          { id: 'segment-2', text: 'Second.' },
        ],
      }),
    ).toEqual([
      {
        id: 'segment-1',
        ordinal: 0,
        startUtf16: 0,
        endUtf16: 6,
        quote: 'First.',
        audioRange: { startMs: 0, endMs: 500 },
      },
      {
        id: 'segment-2',
        ordinal: 1,
        startUtf16: 8,
        endUtf16: 15,
        quote: 'Second.',
      },
    ]);
    expect(audioEvidenceRange(10, 11)).toEqual({ startMs: 10, endMs: 11 });
    expect(() => audioEvidenceRange(10, 10)).toThrowError(/non-empty/);
    expect(() =>
      locateTranscriptSegments({
        evidenceText: 'First.',
        segments: [{ id: 'missing', text: 'Second.' }],
      }),
    ).toThrowError(/resolve in order/);
  });
});
