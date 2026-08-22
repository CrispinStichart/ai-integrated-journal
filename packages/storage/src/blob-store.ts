/** A half-open byte range: `start` is included and `endExclusive` is not. */
export type ByteRange = Readonly<{
  start: bigint;
  endExclusive?: bigint;
}>;

export type BlobIntegrity = Readonly<{
  byteSize: bigint;
  sha256: string;
}>;

/** Provider-neutral metadata required to publish an immutable object. */
export type BlobMetadata = Readonly<{
  key: string;
  expectedIntegrity?: BlobIntegrity;
}>;

export type StoredBlobMetadata = Readonly<{
  key: string;
  byteSize: bigint;
  sha256: string;
  modifiedAt: Date;
}>;

export type StoredBlob = StoredBlobMetadata;

export type StagedChunk = Readonly<{
  uploadId: string;
  index: number;
  stagingKey: string;
  byteSize: bigint;
  sha256: string;
}>;

/** Storage boundary that never exposes provider paths or SDK handles. */
export interface BlobStore {
  putImmutable(
    input: AsyncIterable<Uint8Array>,
    metadata: BlobMetadata,
  ): Promise<StoredBlob>;
  putStagingChunk(
    uploadId: string,
    index: number,
    input: AsyncIterable<Uint8Array>,
    checksum: string,
  ): Promise<StagedChunk>;
  finalizeChunks(
    uploadId: string,
    orderedChunks: readonly StagedChunk[] | AsyncIterable<StagedChunk>,
    metadata: BlobMetadata,
  ): Promise<StoredBlob>;
  open(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>;
  stat(key: string): Promise<StoredBlobMetadata>;
  delete(key: string): Promise<void>;
}

export class InvalidBlobKeyError extends TypeError {
  public constructor() {
    super('Blob keys must be non-empty, relative, canonical opaque keys.');
    this.name = 'InvalidBlobKeyError';
  }
}

export class InvalidBlobChecksumError extends TypeError {
  public constructor() {
    super('Blob checksums must be lowercase SHA-256 hex values.');
    this.name = 'InvalidBlobChecksumError';
  }
}

export class BlobConflictError extends Error {
  public constructor(
    message = 'Immutable blob content conflicts with storage.',
  ) {
    super(message);
    this.name = 'BlobConflictError';
  }
}

export class BlobNotFoundError extends Error {
  public constructor() {
    super('Blob not found.');
    this.name = 'BlobNotFoundError';
  }
}

export class BlobRangeNotSatisfiableError extends RangeError {
  public constructor() {
    super('The requested blob byte range is not satisfiable.');
    this.name = 'BlobRangeNotSatisfiableError';
  }
}

const keySegmentPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const checksumPattern = /^[0-9a-f]{64}$/;

export function assertValidBlobKey(key: string): void {
  if (
    key.length === 0 ||
    key.includes('\\') ||
    key.includes('\0') ||
    key.split('/').some((segment) => !keySegmentPattern.test(segment))
  ) {
    throw new InvalidBlobKeyError();
  }
}

export function assertValidSha256(checksum: string): void {
  if (!checksumPattern.test(checksum)) {
    throw new InvalidBlobChecksumError();
  }
}
