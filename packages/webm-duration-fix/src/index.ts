export {
  assertWebmContainer,
  finalizeWebmBytes,
  type FinalizedWebmBytes,
  type WebmContainerFinalizer,
} from './container.js';
export { finalizeWebmBlob, type FinalizedWebmBlob } from './blob.js';

/** Identifies the owning workspace package without exposing implementation paths. */
export const webmDurationFixPackageName = '@journal/webm-duration-fix' as const;
