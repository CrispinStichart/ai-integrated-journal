import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  BlobConflictError,
  BlobNotFoundError,
  BlobRangeNotSatisfiableError,
  type BlobStore,
} from '../src/index.js';

export type BlobStoreFixture = Readonly<{
  store: BlobStore;
  dispose: () => Promise<void>;
}>;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function* stream(
  ...parts: readonly string[]
): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

async function readBody(body: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let result = '';
  for await (const bytes of body)
    result += decoder.decode(bytes, { stream: true });
  return result + decoder.decode();
}

/** Runs unchanged against every BlobStore adapter. */
export function runBlobStoreContract(
  adapterName: string,
  createFixture: () => Promise<BlobStoreFixture>,
): void {
  describe(`${adapterName} BlobStore contract`, () => {
    it('CAP-005 streams immutable writes and reports incremental SHA-256', async () => {
      const fixture = await createFixture();
      try {
        const stored = await fixture.store.putImmutable(
          stream('recoverable ', 'audio'),
          {
            key: 'audio/01/original.webm',
          },
        );

        expect(stored).toMatchObject({
          key: 'audio/01/original.webm',
          byteSize: 17n,
          sha256: sha256(new TextEncoder().encode('recoverable audio')),
        });
        expect(stored.modifiedAt).toBeInstanceOf(Date);
        expect(await readBody(await fixture.store.open(stored.key))).toBe(
          'recoverable audio',
        );
      } finally {
        await fixture.dispose();
      }
    });

    it('DATA-021 makes identical immutable retries idempotent and rejects conflicts', async () => {
      const fixture = await createFixture();
      try {
        const first = await fixture.store.putImmutable(stream('same'), {
          key: 'artifacts/source.bin',
        });
        const retry = await fixture.store.putImmutable(stream('same'), {
          key: 'artifacts/source.bin',
        });
        expect(retry).toEqual(first);
        await expect(
          fixture.store.putImmutable(stream('different'), {
            key: 'artifacts/source.bin',
          }),
        ).rejects.toBeInstanceOf(BlobConflictError);
        expect(await readBody(await fixture.store.open(first.key))).toBe(
          'same',
        );
      } finally {
        await fixture.dispose();
      }
    });

    it('CAP-003 stages checksummed chunks and finalizes them in order', async () => {
      const fixture = await createFixture();
      try {
        const firstBytes = new TextEncoder().encode('long ');
        const secondBytes = new TextEncoder().encode('recording');
        const first = await fixture.store.putStagingChunk(
          'upload-1',
          0,
          stream('long '),
          sha256(firstBytes),
        );
        const second = await fixture.store.putStagingChunk(
          'upload-1',
          1,
          stream('record', 'ing'),
          sha256(secondBytes),
        );
        const completeBytes = new TextEncoder().encode('long recording');
        const expectedIntegrity = {
          byteSize: BigInt(completeBytes.byteLength),
          sha256: sha256(completeBytes),
        };

        const stored = await fixture.store.finalizeChunks(
          'upload-1',
          [first, second],
          { key: 'audio/final/original.webm', expectedIntegrity },
        );
        expect(stored).toMatchObject(expectedIntegrity);
        expect(await readBody(await fixture.store.open(stored.key))).toBe(
          'long recording',
        );

        expect(
          await fixture.store.finalizeChunks('upload-1', [first, second], {
            key: stored.key,
            expectedIntegrity,
          }),
        ).toEqual(stored);
      } finally {
        await fixture.dispose();
      }
    });

    it('CAP-004 rejects checksum, chunk retry, order, and final integrity conflicts', async () => {
      const fixture = await createFixture();
      try {
        await expect(
          fixture.store.putStagingChunk(
            'upload-2',
            0,
            stream('bytes'),
            sha256(new TextEncoder().encode('other')),
          ),
        ).rejects.toBeInstanceOf(BlobConflictError);

        const chunk = await fixture.store.putStagingChunk(
          'upload-2',
          0,
          stream('bytes'),
          sha256(new TextEncoder().encode('bytes')),
        );
        await expect(
          fixture.store.putStagingChunk(
            'upload-2',
            0,
            stream('other'),
            sha256(new TextEncoder().encode('other')),
          ),
        ).rejects.toBeInstanceOf(BlobConflictError);
        await expect(
          fixture.store.finalizeChunks('upload-2', [{ ...chunk, index: 1 }], {
            key: 'audio/conflict.webm',
          }),
        ).rejects.toBeInstanceOf(BlobConflictError);
        await expect(
          fixture.store.finalizeChunks('upload-2', [chunk], {
            key: 'audio/conflict.webm',
            expectedIntegrity: {
              byteSize: chunk.byteSize,
              sha256: '0'.repeat(64),
            },
          }),
        ).rejects.toBeInstanceOf(BlobConflictError);
      } finally {
        await fixture.dispose();
      }
    });

    it('CAP-005 serves bounded half-open byte ranges', async () => {
      const fixture = await createFixture();
      try {
        await fixture.store.putImmutable(stream('0123456789'), {
          key: 'audio/ranges.bin',
        });
        expect(
          await readBody(
            await fixture.store.open('audio/ranges.bin', {
              start: 2n,
              endExclusive: 6n,
            }),
          ),
        ).toBe('2345');
        expect(
          await readBody(
            await fixture.store.open('audio/ranges.bin', {
              start: 8n,
              endExclusive: 20n,
            }),
          ),
        ).toBe('89');
        await expect(
          fixture.store.open('audio/ranges.bin', { start: 11n }),
        ).rejects.toBeInstanceOf(BlobRangeNotSatisfiableError);
        await expect(
          fixture.store.open('audio/ranges.bin', { start: -1n }),
        ).rejects.toBeInstanceOf(BlobRangeNotSatisfiableError);
        await expect(
          fixture.store.open('audio/ranges.bin', {
            start: 5n,
            endExclusive: 4n,
          }),
        ).rejects.toBeInstanceOf(BlobRangeNotSatisfiableError);
        expect(
          await readBody(
            await fixture.store.open('audio/ranges.bin', {
              start: 10n,
              endExclusive: 10n,
            }),
          ),
        ).toBe('');
      } finally {
        await fixture.dispose();
      }
    });

    it('prevents key traversal and provides idempotent deletion', async () => {
      const fixture = await createFixture();
      try {
        for (const key of [
          '',
          '/absolute',
          '../escape',
          'safe/../escape',
          'a//b',
        ]) {
          await expect(
            fixture.store.putImmutable(stream('private'), { key }),
          ).rejects.toThrow(TypeError);
        }
        await fixture.store.putImmutable(stream('delete me'), {
          key: 'audio/deleted.bin',
        });
        await fixture.store.delete('audio/deleted.bin');
        await fixture.store.delete('audio/deleted.bin');
        await expect(
          fixture.store.stat('audio/deleted.bin'),
        ).rejects.toBeInstanceOf(BlobNotFoundError);
      } finally {
        await fixture.dispose();
      }
    });

    it('rejects malformed staging identities and integrity metadata', async () => {
      const fixture = await createFixture();
      try {
        await expect(
          fixture.store.putStagingChunk(
            '',
            0,
            stream('x'),
            sha256(new Uint8Array()),
          ),
        ).rejects.toThrow(TypeError);
        await expect(
          fixture.store.putStagingChunk(
            'upload-3',
            -1,
            stream('x'),
            sha256(new Uint8Array()),
          ),
        ).rejects.toThrow(RangeError);
        await expect(
          fixture.store.putStagingChunk('upload-3', 0, stream('x'), 'INVALID'),
        ).rejects.toThrow(TypeError);
        await expect(
          fixture.store.putImmutable(stream('x'), {
            key: 'audio/invalid-integrity.bin',
            expectedIntegrity: { byteSize: -1n, sha256: '0'.repeat(64) },
          }),
        ).rejects.toThrow(RangeError);
        await expect(
          fixture.store.putImmutable(stream('x'), {
            key: 'audio/integrity-conflict.bin',
            expectedIntegrity: {
              byteSize: 2n,
              sha256: sha256(new Uint8Array()),
            },
          }),
        ).rejects.toBeInstanceOf(BlobConflictError);
      } finally {
        await fixture.dispose();
      }
    });
  });
}
