import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BlobConflictError,
  LocalBlobStore,
  storagePackageName,
} from '../src/index.js';
import { runBlobStoreContract } from './blob-store-contract.js';

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'journal-blob-store-'));
}

async function* stream(value: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

runBlobStoreContract('local filesystem', async () => {
  const root = await temporaryRoot();
  return {
    store: new LocalBlobStore(root),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
});

describe('@journal/storage operational shell', () => {
  it('exposes its package identity', () => {
    expect(storagePackageName).toBe('@journal/storage');
  });
});

describe('LocalBlobStore filesystem guarantees', () => {
  it('requires an absolute storage root', () => {
    expect(() => new LocalBlobStore('relative/blobs')).toThrow(TypeError);
    expect(() => new LocalBlobStore(path.parse(process.cwd()).root)).toThrow(
      TypeError,
    );
  });

  it('uses owner-only directory and file permissions', async () => {
    const root = await temporaryRoot();
    try {
      await mkdir(path.join(root, 'final'), { recursive: true, mode: 0o777 });
      const store = new LocalBlobStore(root);
      await store.putImmutable(stream('private'), {
        key: 'audio/01/original.webm',
      });

      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(root, 'final'))).mode & 0o777).toBe(0o700);
      expect(
        (await stat(path.join(root, 'final/audio/01/original.webm'))).mode &
          0o777,
      ).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('atomically publishes exactly one winner under conflicting concurrency', async () => {
    const root = await temporaryRoot();
    try {
      const store = new LocalBlobStore(root);
      const outcomes = await Promise.allSettled([
        store.putImmutable(stream('first'), { key: 'audio/race.bin' }),
        store.putImmutable(stream('second'), { key: 'audio/race.bin' }),
      ]);

      expect(
        outcomes.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = outcomes.find(({ status }) => status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: expect.any(BlobConflictError),
      });
      expect((await store.stat('audio/race.bin')).sha256).toMatch(
        new RegExp(`^(?:${sha256('first')}|${sha256('second')})$`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes unpublished temporary output after a streaming failure', async () => {
    const root = await temporaryRoot();
    try {
      const store = new LocalBlobStore(root);
      const failingInput = (async function* (): AsyncGenerator<Uint8Array> {
        yield new TextEncoder().encode('preserve nothing');
        throw new Error('injected input failure');
      })();

      await expect(
        store.putImmutable(failingInput, { key: 'audio/incomplete.bin' }),
      ).rejects.toThrow('injected input failure');
      expect(await readdir(path.join(root, 'temporary'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects staged corruption and an existing final-object conflict', async () => {
    const root = await temporaryRoot();
    try {
      const store = new LocalBlobStore(root);
      const chunk = await store.putStagingChunk(
        'upload-corrupt',
        0,
        stream('original'),
        sha256('original'),
      );
      await writeFile(
        path.join(root, 'staging', chunk.stagingKey),
        'corrupted',
      );
      await expect(
        store.finalizeChunks('upload-corrupt', [chunk], {
          key: 'audio/corrupt.bin',
        }),
      ).rejects.toBeInstanceOf(BlobConflictError);

      await store.putImmutable(stream('existing'), {
        key: 'audio/existing.bin',
      });
      await expect(
        store.finalizeChunks('upload-corrupt', [chunk], {
          key: 'audio/existing.bin',
          expectedIntegrity: {
            byteSize: 8n,
            sha256: sha256('original'),
          },
        }),
      ).rejects.toBeInstanceOf(BlobConflictError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('streams multiple bounded read chunks, supports cancellation, and reports missing reads', async () => {
    const root = await temporaryRoot();
    try {
      const store = new LocalBlobStore(root);
      const largeValue = 'x'.repeat(70 * 1024);
      await store.putImmutable(stream(largeValue), { key: 'audio/large.bin' });
      const reader = (await store.open('audio/large.bin')).getReader();
      expect((await reader.read()).value?.byteLength).toBe(64 * 1024);
      await reader.cancel();
      await expect(store.open('audio/missing.bin')).rejects.toThrow(
        'Blob not found.',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
