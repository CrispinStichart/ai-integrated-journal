import { describe, expect, it } from 'vitest';

import {
  assertWebmContainer,
  finalizeWebmBlob,
  finalizeWebmBytes,
  NumericOverflowError,
  ResourceLimitError,
  webmDurationFixPackageName,
  UnsupportedWebmInputError,
} from '../src/index.js';
import { missingDurationFixture } from './fixtures.js';

const MINIMAL_WEBM_HEADER = Uint8Array.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
]);

describe('@journal/webm-duration-fix package boundary', () => {
  it('exposes its package identity', () => {
    expect(webmDurationFixPackageName).toBe('@journal/webm-duration-fix');
  });

  it('recognizes WebM without relying on browser APIs', () => {
    expect(() =>
      assertWebmContainer(missingDurationFixture().bytes),
    ).not.toThrow();
    expect(() => assertWebmContainer(Uint8Array.of(1, 2, 3))).toThrow(
      'EBML element IDs cannot exceed four bytes.',
    );
  });

  it('uses typed errors at the container boundary', async () => {
    await expect(finalizeWebmBytes(MINIMAL_WEBM_HEADER)).rejects.toMatchObject({
      code: 'invalid-ebml',
    });
    const otherEbml = MINIMAL_WEBM_HEADER.slice();
    otherEbml.set(new TextEncoder().encode('test'), 8);
    expect(() => assertWebmContainer(otherEbml)).toThrow(
      UnsupportedWebmInputError,
    );
  });

  it('exposes typed numeric and caller-policy failures', async () => {
    const unsafeSize = Uint8Array.from([
      ...MINIMAL_WEBM_HEADER,
      0x18,
      0x53,
      0x80,
      0x67,
      0x01,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xfe,
    ]);
    await expect(finalizeWebmBytes(unsafeSize)).rejects.toBeInstanceOf(
      NumericOverflowError,
    );
    await expect(
      finalizeWebmBytes(missingDurationFixture().bytes, {
        maximumInputBytes: 1,
      }),
    ).rejects.toBeInstanceOf(ResourceLimitError);
  });

  it('adapts Blob input and output only at the browser boundary', async () => {
    const fixture = missingDurationFixture();
    const input = new Blob([Uint8Array.from(fixture.bytes)], {
      type: 'audio/webm;codecs=opus',
    });
    const finalized = await finalizeWebmBlob(input);

    expect(finalized.changed).toBe(true);
    expect(finalized.blob.type).toBe('audio/webm;codecs=opus');
    expect(new Uint8Array(await finalized.blob.arrayBuffer())).toEqual(
      (await finalizeWebmBytes(fixture.bytes)).bytes,
    );
  });
});
