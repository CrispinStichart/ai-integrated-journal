import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  open as openFile,
  rm,
  stat as fileStat,
} from 'node:fs/promises';
import path from 'node:path';

import {
  assertValidBlobKey,
  assertValidSha256,
  BlobConflictError,
  BlobNotFoundError,
  BlobRangeNotSatisfiableError,
  type BlobMetadata,
  type BlobStore,
  type ByteRange,
  type StagedChunk,
  type StoredBlob,
  type StoredBlobMetadata,
} from './blob-store.js';

const directoryMode = 0o700;
const fileMode = 0o600;
const streamChunkSize = 64 * 1024;
const uploadIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

type FileHandle = Awaited<ReturnType<typeof openFile>>;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function assertUploadId(uploadId: string): void {
  if (!uploadIdPattern.test(uploadId)) {
    throw new TypeError('Upload IDs must be non-empty opaque identifiers.');
  }
}

function assertChunkIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError('Chunk indexes must be non-negative safe integers.');
  }
}

function assertExpectedIntegrity(metadata: BlobMetadata): void {
  if (metadata.expectedIntegrity === undefined) return;
  assertValidSha256(metadata.expectedIntegrity.sha256);
  if (metadata.expectedIntegrity.byteSize < 0n) {
    throw new RangeError('Expected byte size cannot be negative.');
  }
}

function sameIntegrity(
  left: Pick<StoredBlobMetadata, 'byteSize' | 'sha256'>,
  right: Pick<StoredBlobMetadata, 'byteSize' | 'sha256'>,
): boolean {
  return left.byteSize === right.byteSize && left.sha256 === right.sha256;
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Preserve the operation's original error.
  }
}

async function* readHandle(
  handle: FileHandle,
): AsyncGenerator<Uint8Array, void, undefined> {
  let position = 0n;
  while (true) {
    const buffer = Buffer.allocUnsafe(streamChunkSize);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      position,
    );
    if (bytesRead === 0) return;
    position += BigInt(bytesRead);
    yield buffer.subarray(0, bytesRead);
  }
}

/** Local-filesystem implementation with immutable, atomic publication. */
export class LocalBlobStore implements BlobStore {
  readonly #root: string;
  readonly #finalRoot: string;
  readonly #stagingRoot: string;
  readonly #temporaryRoot: string;
  readonly #ready: Promise<void>;

  public constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new TypeError('The local blob root must be an absolute path.');
    }
    this.#root = path.resolve(root);
    if (this.#root === path.parse(this.#root).root) {
      throw new TypeError('The local blob root cannot be a filesystem root.');
    }
    this.#finalRoot = path.join(this.#root, 'final');
    this.#stagingRoot = path.join(this.#root, 'staging');
    this.#temporaryRoot = path.join(this.#root, 'temporary');
    this.#ready = this.#initialize();
  }

  async #initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: directoryMode });
    await chmod(this.#root, directoryMode);
    await Promise.all(
      [this.#finalRoot, this.#stagingRoot, this.#temporaryRoot].map(
        async (directory) => {
          await mkdir(directory, { recursive: true, mode: directoryMode });
          await chmod(directory, directoryMode);
        },
      ),
    );
  }

  #finalPath(key: string): string {
    assertValidBlobKey(key);
    return path.join(this.#finalRoot, ...key.split('/'));
  }

  #stagingKey(uploadId: string, index: number): string {
    assertUploadId(uploadId);
    assertChunkIndex(index);
    return `${uploadId}/${index}.chunk`;
  }

  #stagingPath(stagingKey: string): string {
    assertValidBlobKey(stagingKey);
    return path.join(this.#stagingRoot, ...stagingKey.split('/'));
  }

  async #ensureParent(target: string): Promise<void> {
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true, mode: directoryMode });
    await chmod(parent, directoryMode);
  }

  async #syncParent(target: string): Promise<void> {
    const directory = await openFile(path.dirname(target), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async #writeTemporary(
    input: AsyncIterable<Uint8Array>,
  ): Promise<{ path: string; byteSize: bigint; sha256: string }> {
    await this.#ready;
    const temporaryPath = path.join(this.#temporaryRoot, randomUUID());
    const handle = await openFile(temporaryPath, 'wx', fileMode);
    const digest = createHash('sha256');
    let byteSize = 0n;

    try {
      for await (const value of input) {
        const bytes = Buffer.from(value);
        digest.update(bytes);
        byteSize += BigInt(bytes.byteLength);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const result = await handle.write(
            bytes,
            offset,
            bytes.byteLength - offset,
            null,
          );
          if (result.bytesWritten === 0) {
            throw new Error('Local blob write made no progress.');
          }
          offset += result.bytesWritten;
        }
      }
      await handle.sync();
      await handle.close();
      return { path: temporaryPath, byteSize, sha256: digest.digest('hex') };
    } catch (error) {
      await closeQuietly(handle);
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async #publish(
    temporary: Readonly<{ path: string; byteSize: bigint; sha256: string }>,
    target: string,
    key: string,
  ): Promise<StoredBlob> {
    await this.#ensureParent(target);
    try {
      // A hard link atomically creates the destination without rename(2)'s
      // overwrite behavior. The unpublished temporary name is then removed.
      await link(temporary.path, target);
      await rm(temporary.path);
      await this.#syncParent(target);
      return this.stat(key);
    } catch (error) {
      await rm(temporary.path, { force: true });
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      const existing = await this.stat(key);
      if (!sameIntegrity(existing, temporary)) {
        throw new BlobConflictError();
      }
      return existing;
    }
  }

  public async putImmutable(
    input: AsyncIterable<Uint8Array>,
    metadata: BlobMetadata,
  ): Promise<StoredBlob> {
    assertExpectedIntegrity(metadata);
    const target = this.#finalPath(metadata.key);
    const temporary = await this.#writeTemporary(input);
    if (
      metadata.expectedIntegrity !== undefined &&
      !sameIntegrity(temporary, metadata.expectedIntegrity)
    ) {
      await rm(temporary.path, { force: true });
      throw new BlobConflictError(
        'Blob content does not match expected integrity.',
      );
    }
    return this.#publish(temporary, target, metadata.key);
  }

  public async putStagingChunk(
    uploadId: string,
    index: number,
    input: AsyncIterable<Uint8Array>,
    checksum: string,
  ): Promise<StagedChunk> {
    assertValidSha256(checksum);
    const stagingKey = this.#stagingKey(uploadId, index);
    const target = this.#stagingPath(stagingKey);
    const temporary = await this.#writeTemporary(input);
    if (temporary.sha256 !== checksum) {
      await rm(temporary.path, { force: true });
      throw new BlobConflictError('Staging chunk checksum does not match.');
    }

    await this.#ensureParent(target);
    try {
      await link(temporary.path, target);
      await rm(temporary.path);
      await this.#syncParent(target);
    } catch (error) {
      await rm(temporary.path, { force: true });
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      const existing = await this.#hashPath(target);
      if (!sameIntegrity(existing, temporary)) {
        throw new BlobConflictError(
          'Staging chunk retry conflicts with storage.',
        );
      }
    }

    return Object.freeze({
      uploadId,
      index,
      stagingKey,
      byteSize: temporary.byteSize,
      sha256: temporary.sha256,
    });
  }

  public async finalizeChunks(
    uploadId: string,
    orderedChunks: readonly StagedChunk[],
    metadata: BlobMetadata,
  ): Promise<StoredBlob> {
    assertUploadId(uploadId);
    assertExpectedIntegrity(metadata);
    const target = this.#finalPath(metadata.key);

    for (const [index, chunk] of orderedChunks.entries()) {
      if (
        chunk.uploadId !== uploadId ||
        chunk.index !== index ||
        chunk.stagingKey !== this.#stagingKey(uploadId, index) ||
        chunk.byteSize < 0n
      ) {
        throw new BlobConflictError(
          'Staging chunk order or identity conflicts.',
        );
      }
      assertValidSha256(chunk.sha256);
      this.#stagingPath(chunk.stagingKey);
    }

    if (metadata.expectedIntegrity !== undefined) {
      try {
        const existing = await this.stat(metadata.key);
        if (!sameIntegrity(existing, metadata.expectedIntegrity)) {
          throw new BlobConflictError();
        }
        return existing;
      } catch (error) {
        if (!(error instanceof BlobNotFoundError)) throw error;
      }
    }

    const openStagingPath = (stagingPath: string): Promise<FileHandle> =>
      this.#openPath(stagingPath);
    const resolveStagingPath = (stagingKey: string): string =>
      this.#stagingPath(stagingKey);
    const assembled = await this.#writeTemporary(
      (async function* (): AsyncGenerator<Uint8Array, void, undefined> {
        for (const descriptor of orderedChunks) {
          const stagingPath = resolveStagingPath(descriptor.stagingKey);
          const handle = await openStagingPath(stagingPath);
          const digest = createHash('sha256');
          let byteSize = 0n;
          try {
            for await (const bytes of readHandle(handle)) {
              digest.update(bytes);
              byteSize += BigInt(bytes.byteLength);
              yield bytes;
            }
          } finally {
            await closeQuietly(handle);
          }
          if (
            byteSize !== descriptor.byteSize ||
            digest.digest('hex') !== descriptor.sha256
          ) {
            throw new BlobConflictError('Staging chunk integrity conflicts.');
          }
        }
      })(),
    );

    if (
      metadata.expectedIntegrity !== undefined &&
      !sameIntegrity(assembled, metadata.expectedIntegrity)
    ) {
      await rm(assembled.path, { force: true });
      throw new BlobConflictError(
        'Final blob does not match expected integrity.',
      );
    }
    return this.#publish(assembled, target, metadata.key);
  }

  async #openPath(filePath: string): Promise<FileHandle> {
    try {
      return await openFile(filePath, 'r');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new BlobNotFoundError();
      }
      throw error;
    }
  }

  async #hashPath(
    filePath: string,
  ): Promise<{ byteSize: bigint; sha256: string }> {
    const handle = await this.#openPath(filePath);
    const digest = createHash('sha256');
    let byteSize = 0n;
    try {
      for await (const bytes of readHandle(handle)) {
        digest.update(bytes);
        byteSize += BigInt(bytes.byteLength);
      }
      return { byteSize, sha256: digest.digest('hex') };
    } finally {
      await closeQuietly(handle);
    }
  }

  public async stat(key: string): Promise<StoredBlobMetadata> {
    await this.#ready;
    const target = this.#finalPath(key);
    try {
      const [metadata, integrity] = await Promise.all([
        fileStat(target),
        this.#hashPath(target),
      ]);
      if (!metadata.isFile()) throw new BlobNotFoundError();
      return Object.freeze({ key, ...integrity, modifiedAt: metadata.mtime });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new BlobNotFoundError();
      }
      throw error;
    }
  }

  public async open(
    key: string,
    range?: ByteRange,
  ): Promise<ReadableStream<Uint8Array>> {
    await this.#ready;
    const target = this.#finalPath(key);
    let metadata;
    try {
      metadata = await fileStat(target, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new BlobNotFoundError();
      }
      throw error;
    }
    if (!metadata.isFile()) throw new BlobNotFoundError();

    const start = range?.start ?? 0n;
    const requestedEnd = range?.endExclusive ?? metadata.size;
    if (
      start < 0n ||
      requestedEnd < start ||
      start > metadata.size ||
      (start === metadata.size && requestedEnd > start)
    ) {
      throw new BlobRangeNotSatisfiableError();
    }
    const endExclusive =
      requestedEnd > metadata.size ? metadata.size : requestedEnd;
    const handle = await this.#openPath(target);
    let position = start;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await closeQuietly(handle);
    };

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (position >= endExclusive) {
          await close();
          controller.close();
          return;
        }
        const remaining = endExclusive - position;
        const length = Number(
          remaining < BigInt(streamChunkSize)
            ? remaining
            : BigInt(streamChunkSize),
        );
        const buffer = Buffer.allocUnsafe(length);
        try {
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          if (bytesRead === 0) {
            await close();
            controller.close();
            return;
          }
          position += BigInt(bytesRead);
          controller.enqueue(buffer.subarray(0, bytesRead));
        } catch (error) {
          await close();
          controller.error(error);
        }
      },
      async cancel() {
        await close();
      },
    });
  }

  public async delete(key: string): Promise<void> {
    await this.#ready;
    await rm(this.#finalPath(key), { force: true });
  }
}
