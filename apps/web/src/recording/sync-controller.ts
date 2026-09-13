import {
  MAX_AUDIO_CHUNK_BYTES,
  RECORDING_PROTOCOL_VERSION,
  type CreateRecordingRequest,
  type RecordingResource,
} from '@journal/contracts';
import { finalizeWebmBytes } from '@journal/webm-duration-fix';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { readonly, ref } from 'vue';

import {
  createRecording,
  finalizeRecording,
  getRecordingUpload,
  RecordingApiError,
  retryRecordingFinalization,
  uploadRecordingChunk,
} from './api';
import { createUuidV7, moveContributionAtRevision } from '../journal/api';
import { offlineJournal } from '../journal/offline';
import {
  browserMetadata,
  type EncryptedRecordingChunkRecord,
  type JournalIndexedDb,
  type LocalRecordingRecord,
} from '../storage/indexed-db';
import type { ProtectedRecordingChunk } from '../journal/offline';

const MAX_PARALLEL_RECORDINGS = 2;
const encoder = new TextEncoder();

interface UploadStatus {
  readonly recording: RecordingResource;
  readonly acceptedIndexes: readonly number[];
  readonly nextAfter?: number | undefined;
}

interface UploadChunk {
  readonly byteSize: number;
  readonly index: number;
  readonly plaintext: () => Promise<ArrayBuffer>;
  readonly sha256: string;
}

interface UploadRepresentation {
  readonly chunks: readonly UploadChunk[];
  readonly finalSha256: string;
  readonly manifestSha256: string;
  readonly totalBytes: string;
}

class RecordingFinalizationError extends Error {
  constructor(cause: unknown) {
    super(
      'The saved WebM could not be finalized. Your local recording is still available.',
      {
        cause,
      },
    );
    this.name = 'RecordingFinalizationError';
  }
}

export interface RecordingSyncDependencies {
  readonly storage: JournalIndexedDb;
  readonly now: () => Date;
  readonly online: () => boolean;
  readonly decryptChunk: (
    chunk: EncryptedRecordingChunkRecord,
  ) => Promise<ArrayBuffer>;
  readonly protectChunk: (
    recordingId: string,
    index: number,
    chunk: Blob,
  ) => Promise<ProtectedRecordingChunk>;
  readonly finalizeWebm: typeof finalizeWebmBytes;
  readonly create: (
    input: CreateRecordingRequest,
    csrfToken: string,
  ) => Promise<RecordingResource>;
  readonly status: (
    recordingId: string,
    after?: number,
  ) => Promise<UploadStatus>;
  readonly upload: typeof uploadRecordingChunk;
  readonly finalize: typeof finalizeRecording;
  readonly retryFinalization: typeof retryRecordingFinalization;
  readonly move: typeof moveContributionAtRevision;
  readonly createId: () => string;
}

function nativeDependencies(): RecordingSyncDependencies {
  return {
    storage: browserMetadata,
    now: () => new Date(),
    online: () => navigator.onLine,
    decryptChunk: (chunk) => offlineJournal.unprotectRecordingChunk(chunk),
    protectChunk: (recordingId, index, chunk) =>
      offlineJournal.protectRecordingChunk(recordingId, index, chunk),
    finalizeWebm: finalizeWebmBytes,
    create: createRecording,
    status: getRecordingUpload,
    upload: uploadRecordingChunk,
    finalize: finalizeRecording,
    retryFinalization: retryRecordingFinalization,
    move: moveContributionAtRevision,
    createId: () => createUuidV7(),
  };
}

function createRequest(
  recording: LocalRecordingRecord,
): CreateRecordingRequest {
  return {
    recordingId: recording.recordingId,
    contributionId: recording.contributionId,
    uploadId: recording.uploadId,
    proposedJournalDayId: recording.proposedJournalDayId,
    mimeType: recording.mimeType,
    ...(recording.codec === undefined ? {} : { codec: recording.codec }),
    capturedAt: recording.capturedAt,
    capturedTimezone: recording.capturedTimezone,
    journalTimezone: recording.journalTimezone,
    journalDate: recording.journalDate,
    journalDateAssignment: recording.journalDateAssignment,
  };
}

function retryInformation(error: unknown): {
  code: string;
  message: string;
  safe: boolean;
} {
  if (error instanceof RecordingFinalizationError) {
    return {
      code: 'audio_finalization_failed',
      message: error.message,
      safe: true,
    };
  }
  if (error instanceof RecordingApiError) {
    return {
      code: error.code,
      message: error.message,
      safe: error.status >= 500 || error.status === 408 || error.status === 429,
    };
  }
  if (error instanceof DOMException && error.name === 'OperationError') {
    return {
      code: 'local_recording_corrupt',
      message: 'A saved audio checkpoint could not be decrypted.',
      safe: false,
    };
  }
  if (
    error instanceof Error &&
    error.message.includes('checkpoint is missing')
  ) {
    return {
      code: 'local_recording_incomplete',
      message: error.message,
      safe: false,
    };
  }
  return {
    code: 'network_unavailable',
    message: 'Audio is still saved locally. Reconnect and retry the upload.',
    safe: true,
  };
}

const EBML_SIGNATURE = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);

export function isWebmRecording(
  mimeType: string,
  firstBytes: Uint8Array,
): boolean {
  const normalizedMime = mimeType.split(';', 1)[0]?.trim().toLowerCase();
  return (
    (normalizedMime === 'audio/webm' || normalizedMime === 'video/webm') &&
    EBML_SIGNATURE.every((byte, index) => firstBytes[index] === byte)
  );
}

export function splitFinalizedBytes(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += MAX_AUDIO_CHUNK_BYTES
  ) {
    chunks.push(bytes.slice(offset, offset + MAX_AUDIO_CHUNK_BYTES));
  }
  return chunks;
}

/**
 * Reconciles IndexedDB recovery records with the versioned recording protocol.
 * WebM finalization temporarily materializes one bounded complete recording;
 * pass-through uploads continue to hold one decrypted transport unit at a time.
 */
export class RecordingSyncController {
  readonly #dependencies: RecordingSyncDependencies;
  readonly #recordings = ref<readonly LocalRecordingRecord[]>([]);
  #ownerId: string | undefined;
  #csrfToken: string | undefined;
  #syncing: Promise<void> | undefined;

  readonly recordings = readonly(this.#recordings);

  constructor(dependencies: RecordingSyncDependencies = nativeDependencies()) {
    this.#dependencies = dependencies;
  }

  async initialize(ownerId: string, csrfToken: string): Promise<void> {
    this.#ownerId = ownerId;
    this.#csrfToken = csrfToken;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.#recordings.value =
      this.#ownerId === undefined
        ? []
        : await this.#dependencies.storage.listRecordings(this.#ownerId);
  }

  async resume(): Promise<void> {
    if (
      this.#ownerId === undefined ||
      this.#csrfToken === undefined ||
      !this.#dependencies.online()
    )
      return;
    if (this.#syncing !== undefined) return this.#syncing;
    this.#syncing = this.#resumePending().finally(() => {
      this.#syncing = undefined;
    });
    return this.#syncing;
  }

  async retry(recordingId: string): Promise<void> {
    const recording = await this.#requireOwned(recordingId);
    if (recording.state === 'failed' && recording.retrySafe !== true)
      throw new Error(
        'Retry is disabled because the saved recording conflicts with durable data.',
      );
    const updated: LocalRecordingRecord = {
      ...recording,
      state: 'saved_locally',
      retrySafe: true,
      updatedAt: this.#dependencies.now().toISOString(),
    };
    Reflect.deleteProperty(updated, 'syncErrorCode');
    Reflect.deleteProperty(updated, 'syncErrorMessage');
    await this.#dependencies.storage.putRecording(updated);
    await this.refresh();
    await this.#syncOne(recordingId);
  }

  async move(recordingId: string, journalDate: string): Promise<void> {
    const recording = await this.#requireOwned(recordingId);
    const proposedJournalDayId = this.#dependencies.createId();
    if (recording.serverCreated) {
      const csrfToken = this.#csrfToken;
      if (csrfToken === undefined)
        throw new Error('Your session needs to be refreshed.');
      await this.#dependencies.move(
        recording.contributionId,
        0,
        journalDate,
        proposedJournalDayId,
        csrfToken,
        `move-${this.#dependencies.createId()}`,
      );
    }
    await this.#dependencies.storage.putRecording({
      ...recording,
      proposedJournalDayId,
      journalDate,
      journalDateAssignment: 'user_override',
      updatedAt: this.#dependencies.now().toISOString(),
    });
    await this.refresh();
  }

  async #resumePending(): Promise<void> {
    await this.refresh();
    const pending = this.#recordings.value.filter(
      (recording) =>
        (recording.state === 'saved_locally' ||
          recording.state === 'uploading' ||
          (recording.state === 'failed' &&
            recording.syncErrorCode !== undefined &&
            recording.retrySafe === true)) &&
        recording.nextChunkIndex > 0,
    );
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const recording = pending[cursor];
        cursor += 1;
        if (recording !== undefined) await this.#syncOne(recording.recordingId);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_PARALLEL_RECORDINGS, pending.length) },
        worker,
      ),
    );
    await this.refresh();
  }

  async #syncOne(recordingId: string): Promise<void> {
    const csrfToken = this.#csrfToken;
    if (csrfToken === undefined || !this.#dependencies.online()) return;
    let recording = await this.#requireOwned(recordingId);
    try {
      recording = await this.#save({
        ...recording,
        state: 'uploading',
        retrySafe: true,
      });
      if (!recording.serverCreated) {
        const remote = await this.#dependencies.create(
          createRequest(recording),
          csrfToken,
        );
        recording = await this.#save({
          ...recording,
          serverCreated: true,
          serverPersistenceState: remote.persistenceState,
        });
      }

      const status = await this.#dependencies.status(recordingId);
      recording = await this.#save({
        ...recording,
        serverCreated: true,
        serverPersistenceState: status.recording.persistenceState,
      });
      if (status.recording.persistenceState === 'durable') {
        await this.#confirmDurable(recordingId);
        return;
      }
      if (status.recording.persistenceState === 'prepared') {
        const retried = await this.#dependencies.retryFinalization(
          recordingId,
          csrfToken,
        );
        if (retried.persistenceState !== 'durable')
          throw new Error('Durable audio confirmation was not received.');
        await this.#confirmDurable(recordingId);
        return;
      }

      const representation = await this.#prepareUpload(recording);
      await this.#uploadMissing(recording, representation, status, csrfToken);
      const finalized = await this.#dependencies.finalize(
        recordingId,
        {
          manifestVersion: RECORDING_PROTOCOL_VERSION,
          chunkCount: String(representation.chunks.length),
          totalBytes: representation.totalBytes,
          manifestSha256: representation.manifestSha256,
          finalSha256: representation.finalSha256,
          ...(recording.durationMilliseconds === undefined
            ? {}
            : { durationMilliseconds: recording.durationMilliseconds }),
        },
        csrfToken,
      );
      if (finalized.persistenceState !== 'durable')
        throw new Error('Durable audio confirmation was not received.');
      await this.#confirmDurable(recordingId);
    } catch (error) {
      const retry = retryInformation(error);
      await this.#save({
        ...recording,
        state: 'failed',
        retrySafe: retry.safe,
        syncErrorCode: retry.code,
        syncErrorMessage: retry.message,
      });
    }
  }

  async #uploadMissing(
    recording: LocalRecordingRecord,
    representation: UploadRepresentation,
    initial: UploadStatus,
    csrfToken: string,
  ): Promise<void> {
    const accepted = this.#acceptedIndexes(recording.recordingId, initial);
    let nextAccepted = await accepted.next();
    let uploaded = 0;
    for (let index = 0; index < representation.chunks.length; index += 1) {
      while (!nextAccepted.done && nextAccepted.value < index)
        nextAccepted = await accepted.next();
      if (!nextAccepted.done && nextAccepted.value === index) {
        uploaded += 1;
        nextAccepted = await accepted.next();
        continue;
      }
      const chunk = representation.chunks[index];
      if (chunk === undefined)
        throw new Error(`Audio checkpoint is missing at index ${index}.`);
      const plaintext = await chunk.plaintext();
      await this.#dependencies.upload(
        recording.recordingId,
        index,
        chunk.sha256,
        plaintext,
        csrfToken,
      );
      uploaded += 1;
      recording = await this.#save({
        ...recording,
        uploadedChunkCount: uploaded,
      });
    }
  }

  async *#acceptedIndexes(
    recordingId: string,
    initial: UploadStatus,
  ): AsyncGenerator<number> {
    let page = initial;
    while (true) {
      yield* page.acceptedIndexes;
      if (page.nextAfter === undefined) return;
      page = await this.#dependencies.status(recordingId, page.nextAfter);
    }
  }

  async #prepareUpload(
    recording: LocalRecordingRecord,
  ): Promise<UploadRepresentation> {
    const localChunks = await this.#localUploadChunks(recording);
    const first = localChunks[0];
    if (first === undefined) return this.#summarize(localChunks);
    const decryptedPrefix = new Map<number, Uint8Array>();
    const signature = new Uint8Array(EBML_SIGNATURE.byteLength);
    let signatureBytes = 0;
    for (const chunk of localChunks) {
      if (signatureBytes === signature.byteLength) break;
      const plaintext = new Uint8Array(await chunk.plaintext());
      decryptedPrefix.set(chunk.index, plaintext);
      const length = Math.min(
        plaintext.byteLength,
        signature.byteLength - signatureBytes,
      );
      signature.set(plaintext.subarray(0, length), signatureBytes);
      signatureBytes += length;
    }
    if (!isWebmRecording(recording.mimeType, signature))
      return this.#summarize(localChunks);

    const totalBytes = Number(BigInt(recording.totalBytes));
    if (!Number.isSafeInteger(totalBytes)) {
      throw new RecordingFinalizationError(
        new Error('The local recording size is not a safe integer.'),
      );
    }
    const complete = new Uint8Array(totalBytes);
    let offset = 0;
    try {
      for (const chunk of localChunks) {
        const plaintext =
          decryptedPrefix.get(chunk.index) ??
          new Uint8Array(await chunk.plaintext());
        if (plaintext.byteLength !== chunk.byteSize)
          throw new Error(
            `Audio checkpoint byte size differs at index ${chunk.index}.`,
          );
        complete.set(plaintext, offset);
        offset += plaintext.byteLength;
      }
      if (offset !== complete.byteLength)
        throw new Error(
          'Audio checkpoint bytes do not match the local manifest.',
        );
      const result = await this.#dependencies.finalizeWebm(complete);
      if (!result.changed) return this.#summarize(localChunks);
      const protectedChunks = await Promise.all(
        splitFinalizedBytes(result.bytes).map(async (bytes, index) => {
          const protectedChunk = await this.#dependencies.protectChunk(
            recording.recordingId,
            index,
            new Blob([Uint8Array.from(bytes)], { type: recording.mimeType }),
          );
          if (
            protectedChunk.byteSize !== bytes.byteLength ||
            protectedChunk.byteSize > MAX_AUDIO_CHUNK_BYTES
          )
            throw new Error(
              `A finalized audio chunk violated the protocol bound at index ${index}.`,
            );
          const encrypted: EncryptedRecordingChunkRecord = {
            recordingId: recording.recordingId,
            index,
            ownerId: recording.ownerId,
            schemaVersion: 1,
            byteSize: protectedChunk.byteSize,
            sha256: protectedChunk.sha256,
            mimeType: recording.mimeType,
            capturedAt: recording.capturedAt,
            nonce: protectedChunk.nonce,
            ciphertext: protectedChunk.ciphertext,
          };
          return {
            index,
            byteSize: protectedChunk.byteSize,
            sha256: protectedChunk.sha256,
            plaintext: () => this.#dependencies.decryptChunk(encrypted),
          } satisfies UploadChunk;
        }),
      );
      return this.#summarize(protectedChunks);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'OperationError')
        throw error;
      throw new RecordingFinalizationError(error);
    }
  }

  async #localUploadChunks(
    recording: LocalRecordingRecord,
  ): Promise<UploadChunk[]> {
    const chunks: UploadChunk[] = [];
    for (let index = 0; index < recording.nextChunkIndex; index += 1) {
      const chunk = await this.#dependencies.storage.getRecordingChunk(
        recording.recordingId,
        index,
      );
      if (chunk === undefined)
        throw new Error(`Audio checkpoint is missing at index ${index}.`);
      chunks.push({
        index,
        byteSize: chunk.byteSize,
        sha256: chunk.sha256,
        plaintext: () => this.#dependencies.decryptChunk(chunk),
      });
    }
    return chunks;
  }

  async #summarize(
    chunks: readonly UploadChunk[],
  ): Promise<UploadRepresentation> {
    const manifest = sha256.create();
    const final = sha256.create();
    let totalBytes = 0n;
    for (const chunk of chunks) {
      manifest.update(
        encoder.encode(`${chunk.index}:${chunk.byteSize}:${chunk.sha256}\n`),
      );
      final.update(new Uint8Array(await chunk.plaintext()));
      totalBytes += BigInt(chunk.byteSize);
    }
    return {
      chunks,
      totalBytes: totalBytes.toString(),
      manifestSha256: bytesToHex(manifest.digest()),
      finalSha256: bytesToHex(final.digest()),
    };
  }

  async #confirmDurable(recordingId: string): Promise<void> {
    await this.#dependencies.storage.confirmRecordingDurable(
      recordingId,
      this.#dependencies.now().toISOString(),
    );
    await this.refresh();
  }

  async #save(recording: LocalRecordingRecord): Promise<LocalRecordingRecord> {
    const updated = {
      ...recording,
      updatedAt: this.#dependencies.now().toISOString(),
    };
    await this.#dependencies.storage.putRecording(updated);
    await this.refresh();
    return updated;
  }

  async #requireOwned(recordingId: string): Promise<LocalRecordingRecord> {
    const recording =
      await this.#dependencies.storage.getRecording(recordingId);
    if (recording === undefined || recording.ownerId !== this.#ownerId)
      throw new Error('The local recording is unavailable.');
    return recording;
  }
}

export const recordingSyncController = new RecordingSyncController();

export function useRecordingSyncController() {
  return {
    recordings: recordingSyncController.recordings,
    initialize: (ownerId: string, csrfToken: string) =>
      recordingSyncController.initialize(ownerId, csrfToken),
    refresh: () => recordingSyncController.refresh(),
    resume: () => recordingSyncController.resume(),
    retry: (recordingId: string) => recordingSyncController.retry(recordingId),
    move: (recordingId: string, journalDate: string) =>
      recordingSyncController.move(recordingId, journalDate),
  };
}
