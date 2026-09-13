import { describe, expect, it, vi } from 'vitest';

import {
  assertWebmContainer,
  finalizeWebmBlob,
  finalizeWebmBytes,
  webmDurationFixPackageName,
  type WebmContainerFinalizer,
} from '../src/index.js';

const MINIMAL_WEBM_HEADER = Uint8Array.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
]);

describe('@journal/webm-duration-fix package boundary', () => {
  it('exposes its package identity', () => {
    expect(webmDurationFixPackageName).toBe('@journal/webm-duration-fix');
  });

  it('recognizes WebM without relying on browser APIs', () => {
    expect(() => assertWebmContainer(MINIMAL_WEBM_HEADER)).not.toThrow();
    expect(() => assertWebmContainer(Uint8Array.of(1, 2, 3))).toThrow(
      'WebM input has an invalid or truncated element ID.',
    );
  });

  it('validates byte input and finalized output at the container boundary', async () => {
    const finalizeContainer: WebmContainerFinalizer = vi.fn((bytes) => ({
      bytes: bytes.slice(),
      changed: false,
    }));

    await expect(
      finalizeWebmBytes(MINIMAL_WEBM_HEADER, finalizeContainer),
    ).resolves.toEqual({ bytes: MINIMAL_WEBM_HEADER, changed: false });
    expect(finalizeContainer).toHaveBeenCalledOnce();
  });

  it('adapts Blob input and output only at the browser boundary', async () => {
    const input = new Blob([MINIMAL_WEBM_HEADER], {
      type: 'audio/webm;codecs=opus',
    });
    const finalized = await finalizeWebmBlob(input, (bytes) => ({
      bytes: bytes.slice(),
      changed: true,
    }));

    expect(finalized.changed).toBe(true);
    expect(finalized.blob.type).toBe('audio/webm;codecs=opus');
    expect(new Uint8Array(await finalized.blob.arrayBuffer())).toEqual(
      MINIMAL_WEBM_HEADER,
    );
  });
});
