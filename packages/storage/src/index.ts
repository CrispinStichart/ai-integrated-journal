export {
  assertValidBlobKey,
  assertValidSha256,
  BlobConflictError,
  BlobNotFoundError,
  BlobRangeNotSatisfiableError,
  InvalidBlobChecksumError,
  InvalidBlobKeyError,
  type BlobIntegrity,
  type BlobMetadata,
  type BlobStore,
  type ByteRange,
  type StagedChunk,
  type StoredBlob,
  type StoredBlobMetadata,
} from './blob-store.js';
export { LocalBlobStore } from './local-blob-store.js';

/** Identifies the owning workspace package without exposing implementation paths. */
export const storagePackageName = '@journal/storage' as const;
