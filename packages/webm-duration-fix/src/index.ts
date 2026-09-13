export {
  assertWebmContainer,
  finalizeWebmBytes,
  type FinalizeWebmOptions,
  type FinalizedWebmBytes,
} from './container.js';
export { finalizeWebmBlob, type FinalizedWebmBlob } from './blob.js';
export {
  InvalidEbmlError,
  NumericOverflowError,
  ResourceLimitError,
  TruncatedDataError,
  UnsupportedWebmInputError,
  WebmFinalizeError,
  type WebmFinalizeErrorCode,
} from './errors.js';

/** Identifies the owning workspace package without exposing implementation paths. */
export const webmDurationFixPackageName = '@journal/webm-duration-fix' as const;
