import { finalizeWebmBytes, type WebmContainerFinalizer } from './container.js';

export interface FinalizedWebmBlob {
  readonly blob: Blob;
  readonly changed: boolean;
}

/** Browser-facing adaptation around the platform-neutral byte finalizer. */
export async function finalizeWebmBlob(
  input: Blob,
  finalizeContainer: WebmContainerFinalizer,
): Promise<FinalizedWebmBlob> {
  const result = await finalizeWebmBytes(
    new Uint8Array(await input.arrayBuffer()),
    finalizeContainer,
  );
  return {
    blob: new Blob([Uint8Array.from(result.bytes)], {
      type: input.type || 'audio/webm',
    }),
    changed: result.changed,
  };
}
