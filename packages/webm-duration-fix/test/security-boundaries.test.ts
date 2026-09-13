import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  concatBytes,
  readElementId,
  readElementSize,
  writeVariableSize,
} from '../src/bytes.js';
import { assertInputSize, finalizeWebmBytes } from '../src/container.js';
import { idBytes } from '../src/encoder.js';
import {
  InvalidEbmlError,
  ResourceLimitError,
  WebmFinalizeError,
} from '../src/errors.js';
import {
  MAX_EBML_ELEMENT_COUNT,
  MAX_EBML_NESTING_DEPTH,
  MAX_WEBM_INPUT_BYTES,
  MAX_WEBM_METADATA_BYTES,
} from '../src/limits.js';
import { parseWebm } from '../src/parser.js';
import { missingDurationFixture } from './fixtures.js';

function element(id: number, data: Uint8Array): Uint8Array {
  return concatBytes([idBytes(id), writeVariableSize(data.byteLength), data]);
}

function nestedWebm(depth: number): Uint8Array {
  let nested = element(0xec, new Uint8Array());
  for (let index = 0; index < depth; index += 1) {
    nested = element(0x80, nested);
  }
  const header = element(
    0x1a45dfa3,
    concatBytes([element(0x4282, new TextEncoder().encode('webm')), nested]),
  );
  return concatBytes([header, element(0x18538067, new Uint8Array())]);
}

function insertBeforeFirstCluster(
  bytes: Uint8Array,
  inserted: Uint8Array,
): Uint8Array {
  const marker = Uint8Array.of(0x1f, 0x43, 0xb6, 0x75);
  const clusterOffset = bytes.findIndex((_, offset) =>
    marker.every((byte, index) => bytes[offset + index] === byte),
  );
  if (clusterOffset < 0) throw new Error('Fixture has no Cluster marker.');
  return concatBytes([
    bytes.subarray(0, clusterOffset),
    inserted,
    bytes.subarray(clusterOffset),
  ]);
}

async function outcome(bytes: Uint8Array): Promise<string> {
  try {
    const result = await finalizeWebmBytes(bytes);
    return `success:${result.changed}:${result.bytes.byteLength}`;
  } catch (error) {
    if (!(error instanceof WebmFinalizeError)) throw error;
    return `${error.code}:${error.message}`;
  }
}

describe('WebM resource and security boundaries', () => {
  it('publishes operation limits tied to existing application byte bounds', () => {
    expect(MAX_WEBM_INPUT_BYTES).toBe(128 * 1024 * 1024);
    expect(MAX_WEBM_METADATA_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_EBML_NESTING_DEPTH).toBe(32);
    expect(MAX_EBML_ELEMENT_COUNT).toBe(500_000);
    expect(() => assertInputSize(MAX_WEBM_INPUT_BYTES, {})).not.toThrow();
    expect(() => assertInputSize(MAX_WEBM_INPUT_BYTES + 1, {})).toThrow(
      ResourceLimitError,
    );
  });

  it('rejects invalid policies and applies tighter caller limits before work', async () => {
    const bytes = missingDurationFixture().bytes;
    await expect(
      finalizeWebmBytes(bytes, { maximumInputBytes: bytes.byteLength - 1 }),
    ).rejects.toBeInstanceOf(ResourceLimitError);
    await expect(
      finalizeWebmBytes(bytes, { maximumMetadataBytes: 1 }),
    ).rejects.toBeInstanceOf(ResourceLimitError);
    await expect(
      finalizeWebmBytes(bytes, { maximumInputBytes: Number.NaN }),
    ).rejects.toMatchObject({ code: 'numeric-overflow' });
  });

  it('rejects excessive recursion and element counts with typed errors', () => {
    expect(() => parseWebm(nestedWebm(4), { maximumNestingDepth: 3 })).toThrow(
      ResourceLimitError,
    );
    expect(() => parseWebm(nestedWebm(1), { maximumElements: 2 })).toThrow(
      ResourceLimitError,
    );
  });

  it('rejects impossible offsets and unknown sizes on leaf elements', () => {
    expect(() => readElementId(Uint8Array.of(0x81), -1)).toThrow(
      InvalidEbmlError,
    );
    expect(() =>
      readElementSize(Uint8Array.of(0x81), Number.MAX_SAFE_INTEGER),
    ).toThrow(InvalidEbmlError);
    expect(() => parseWebm(Uint8Array.of(0xec, 0xff))).toThrow(
      'An unknown EBML element size is only valid for a master element.',
    );
  });

  it('advances across many opaque zero-length elements without looping', async () => {
    const fixture = missingDurationFixture();
    const opaque = concatBytes(
      Array.from({ length: 10_000 }, () => Uint8Array.of(0xec, 0x80)),
    );
    const input = insertBeforeFirstCluster(fixture.bytes, opaque);
    const result = await finalizeWebmBytes(input);

    expect(result.changed).toBe(true);
    expect(result.bytes.byteLength).toBeGreaterThan(input.byteLength);
  });

  it('never mutates or returns partial output when malformed input fails', async () => {
    const valid = missingDurationFixture().bytes;
    const truncated = valid.slice(0, -8);
    const original = truncated.slice();

    await expect(finalizeWebmBytes(truncated)).rejects.toMatchObject({
      code: 'truncated-data',
    });
    expect(truncated).toEqual(original);
  });
});

describe('EBML VINT properties', () => {
  it('round-trips every generated safe non-negative element size', () => {
    fc.assert(
      fc.property(fc.maxSafeNat(), (value) => {
        const encoded = writeVariableSize(value);
        const decoded = readElementSize(encoded, 0);
        expect(decoded).toEqual({
          length: encoded.byteLength,
          unknown: false,
          value,
        });
      }),
      { numRuns: 1_000 },
    );
  });

  it('classifies arbitrary VINT byte strings deterministically', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 12 }),
        fc.integer({ min: -2, max: 14 }),
        (bytes, offset) => {
          const read = (): string => {
            try {
              return JSON.stringify(readElementSize(bytes, offset));
            } catch (error) {
              if (!(error instanceof WebmFinalizeError)) throw error;
              return `${error.code}:${error.message}`;
            }
          };
          expect(read()).toBe(read());
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe('malformed EBML tree properties', () => {
  it('rejects every strict truncation without changing the supplied bytes', async () => {
    const valid = missingDurationFixture().bytes;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: valid.byteLength - 1 }),
        async (length) => {
          const truncated = valid.slice(0, length);
          const original = truncated.slice();
          await expect(finalizeWebmBytes(truncated)).rejects.toBeInstanceOf(
            WebmFinalizeError,
          );
          expect(truncated).toEqual(original);
        },
      ),
      { numRuns: 250 },
    );
  });

  it('terminates arbitrary malformed trees with a repeatable outcome', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (bytes) => {
        const original = bytes.slice();
        expect(await outcome(bytes)).toBe(await outcome(bytes));
        expect(bytes).toEqual(original);
      }),
      { numRuns: 500 },
    );
  });
});
