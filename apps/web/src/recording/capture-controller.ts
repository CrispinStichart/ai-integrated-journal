import {
  MAX_AUDIO_CHUNK_BYTES,
  createRecordingRequestSchema,
  type CreateRecordingRequest,
} from '@journal/contracts';
import { readonly, ref } from 'vue';

import { createUuidV7 } from '../journal/api';
import {
  offlineJournal,
  type ProtectedRecordingChunk,
} from '../journal/offline';
import {
  browserMetadata,
  type EncryptedRecordingChunkRecord,
  type LocalRecordingRecord,
} from '../storage/indexed-db';

export const CAPTURE_TIMESLICE_MILLISECONDS = 5_000;
export const BROWSER_STORAGE_LOW_BYTES = 128 * 1024 * 1024;
export const BROWSER_STORAGE_SAFETY_RESERVE_BYTES = 32 * 1024 * 1024;
export const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
] as const;

export type CapturePhase =
  | 'idle'
  | 'requesting_permission'
  | 'recording'
  | 'stopping'
  | 'saved_locally'
  | 'failed';
export type BrowserStorageState = 'unknown' | 'available' | 'low' | 'exhausted';

export interface CaptureSnapshot {
  readonly phase: CapturePhase;
  readonly storageState: BrowserStorageState;
  readonly recordingId?: string;
  readonly contributionId?: string;
  readonly uploadId?: string;
  readonly lastSavedChunkIndex?: number;
  readonly remainingBytes?: number;
  readonly errorCode?: 'browser_storage_exhausted' | 'capture_failed';
  readonly message?: string;
}

export interface StartCaptureInput {
  readonly ownerId: string;
  readonly proposedJournalDayId: string;
  readonly journalDate: string;
  readonly journalTimezone: string;
  readonly journalDateAssignment: 'default' | 'user_override' | 'migration';
}

export interface CaptureIdentities {
  readonly recordingId: string;
  readonly contributionId: string;
  readonly uploadId: string;
}

interface RecorderLike {
  readonly mimeType: string;
  readonly state: RecordingState;
  start(timeslice?: number): void;
  stop(): void;
  addEventListener(
    type: 'dataavailable',
    listener: (event: BlobEvent) => void,
  ): void;
  addEventListener(
    type: 'error' | 'stop',
    listener: (event: Event) => void,
  ): void;
}

interface CaptureStorage {
  putRecording(record: LocalRecordingRecord): Promise<void>;
  commitRecordingChunk(
    recordingId: string,
    chunk: EncryptedRecordingChunkRecord,
    committedAt: string,
  ): Promise<LocalRecordingRecord>;
}

interface StorageManagerLike {
  estimate?(): Promise<StorageEstimate>;
  persist?(): Promise<boolean>;
}

export interface BrowserCaptureDependencies {
  readonly storage: CaptureStorage;
  readonly storageManager: StorageManagerLike | undefined;
  readonly createId: () => string;
  readonly now: () => Date;
  readonly captureTimezone: () => string;
  readonly getUserMedia: () => Promise<MediaStream>;
  readonly isTypeSupported: (mimeType: string) => boolean;
  readonly createRecorder: (
    stream: MediaStream,
    mimeType: string | undefined,
  ) => RecorderLike;
  readonly protectChunk: (
    recordingId: string,
    index: number,
    chunk: Blob,
  ) => Promise<ProtectedRecordingChunk>;
  readonly evictReadCache: () => Promise<void>;
}

interface StorageAssessment {
  readonly state: Exclude<BrowserStorageState, 'exhausted'>;
  readonly canAcceptCheckpoint: boolean;
  readonly remainingBytes?: number;
}

class LocalRecordingPersistenceError extends Error {
  constructor(cause: unknown) {
    super('The recording checkpoint could not be saved locally.', { cause });
    this.name = 'LocalRecordingPersistenceError';
  }
}

function nativeDependencies(): BrowserCaptureDependencies {
  return {
    storage: browserMetadata,
    storageManager: navigator.storage,
    createId: () => createUuidV7(),
    now: () => new Date(),
    captureTimezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    isTypeSupported: (mimeType) => MediaRecorder.isTypeSupported(mimeType),
    createRecorder: (stream, mimeType) =>
      mimeType === undefined
        ? new MediaRecorder(stream)
        : new MediaRecorder(stream, { mimeType }),
    protectChunk: (recordingId, index, chunk) =>
      offlineJournal.protectRecordingChunk(recordingId, index, chunk),
    evictReadCache: () => offlineJournal.clearReadCache(),
  };
}

function codecFromMimeType(mimeType: string): string | undefined {
  const match = /(?:^|;)\s*codecs\s*=\s*"?([^";]+)"?/i.exec(mimeType);
  return match?.[1]?.trim();
}

function isFiniteEstimate(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function stopTracks(stream: MediaStream | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function storageCommitFailed(error: unknown): boolean {
  return (
    error instanceof LocalRecordingPersistenceError ||
    (error instanceof DOMException &&
      (error.name === 'QuotaExceededError' || error.name === 'AbortError'))
  );
}

function captureFailureMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError')
    return 'Microphone permission was denied. Allow access and try again.';
  if (error instanceof Error || error instanceof DOMException)
    return error.message;
  return 'Audio capture failed.';
}

/**
 * Owns browser audio capture independently of any route component. IndexedDB,
 * not this controller's reactive snapshot, remains the recovery authority.
 */
export class BrowserCaptureController {
  readonly #dependencies: BrowserCaptureDependencies;
  readonly #snapshot = ref<CaptureSnapshot>({
    phase: 'idle',
    storageState: 'unknown',
  });
  #recording: LocalRecordingRecord | undefined;
  #recorder: RecorderLike | undefined;
  #stream: MediaStream | undefined;
  #writeQueue: Promise<void> = Promise.resolve();
  #stopPromise: Promise<void> | undefined;
  #resolveStop: (() => void) | undefined;
  #acceptingData = false;

  readonly snapshot = readonly(this.#snapshot);

  constructor(dependencies: BrowserCaptureDependencies = nativeDependencies()) {
    this.#dependencies = dependencies;
  }

  async start(input: StartCaptureInput): Promise<CaptureIdentities> {
    if (this.#recorder !== undefined || this.#recording !== undefined)
      throw new Error('A recording is already active.');

    // These stable identities intentionally precede every capture-side effect.
    const identities: CaptureIdentities = {
      recordingId: this.#dependencies.createId(),
      contributionId: this.#dependencies.createId(),
      uploadId: this.#dependencies.createId(),
    };
    this.#snapshot.value = {
      phase: 'requesting_permission',
      storageState: 'unknown',
      ...identities,
    };

    try {
      await this.#dependencies.storageManager?.persist?.().catch(() => false);
      const initialStorage = await this.#assessStorage(true);
      this.#applyStorageAssessment(initialStorage);
      if (!initialStorage.canAcceptCheckpoint) {
        this.#snapshot.value = {
          ...this.#snapshot.value,
          phase: 'failed',
          storageState: 'exhausted',
          errorCode: 'browser_storage_exhausted',
          message:
            'Browser storage cannot safely hold another recording checkpoint.',
        };
        throw new Error(this.#snapshot.value.message);
      }

      const selectedMimeType = AUDIO_MIME_CANDIDATES.find((candidate) =>
        this.#dependencies.isTypeSupported(candidate),
      );
      this.#stream = await this.#dependencies.getUserMedia();
      this.#recorder = this.#dependencies.createRecorder(
        this.#stream,
        selectedMimeType,
      );
      const actualMimeType = this.#recorder.mimeType.trim();
      if (actualMimeType === '')
        throw new Error('The browser did not report an audio MIME type.');

      const capturedAt = this.#dependencies.now().toISOString();
      const request: CreateRecordingRequest =
        createRecordingRequestSchema.parse({
          ...identities,
          proposedJournalDayId: input.proposedJournalDayId,
          mimeType: actualMimeType,
          ...(codecFromMimeType(actualMimeType) === undefined
            ? {}
            : { codec: codecFromMimeType(actualMimeType) }),
          capturedAt,
          capturedTimezone: this.#dependencies.captureTimezone(),
          journalTimezone: input.journalTimezone,
          journalDate: input.journalDate,
          journalDateAssignment: input.journalDateAssignment,
        });
      const localRecording: LocalRecordingRecord = {
        recordingId: request.recordingId,
        contributionId: request.contributionId,
        uploadId: request.uploadId,
        proposedJournalDayId: request.proposedJournalDayId,
        ownerId: input.ownerId,
        schemaVersion: 1,
        mimeType: request.mimeType,
        ...(request.codec === undefined ? {} : { codec: request.codec }),
        capturedAt: request.capturedAt,
        capturedTimezone: request.capturedTimezone,
        journalTimezone: request.journalTimezone,
        journalDate: request.journalDate,
        journalDateAssignment: request.journalDateAssignment,
        state: 'recording',
        nextChunkIndex: 0,
        totalBytes: '0',
        createdAt: capturedAt,
        updatedAt: capturedAt,
      };
      this.#recording = localRecording;
      await this.#dependencies.storage.putRecording(localRecording);
      this.#attachRecorderEvents(this.#recorder);
      this.#acceptingData = true;
      this.#recorder.start(CAPTURE_TIMESLICE_MILLISECONDS);
      this.#snapshot.value = {
        ...this.#snapshot.value,
        phase: 'recording',
      };
      return identities;
    } catch (error) {
      if (this.#snapshot.value.phase !== 'failed')
        await this.#failCapture(
          error,
          storageCommitFailed(error)
            ? 'browser_storage_exhausted'
            : 'capture_failed',
        );
      stopTracks(this.#stream);
      this.#stream = undefined;
      this.#recorder = undefined;
      if (this.#recording?.nextChunkIndex === 0) this.#recording = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const recorder = this.#recorder;
    if (recorder === undefined) return;
    if (recorder.state === 'inactive') return this.#stopPromise;
    this.#snapshot.value = { ...this.#snapshot.value, phase: 'stopping' };
    recorder.stop();
    await this.#stopPromise;
  }

  async checkStorage(): Promise<void> {
    if (this.#recorder?.state !== 'recording') return;
    const assessment = await this.#assessStorage(true);
    this.#applyStorageAssessment(assessment);
    if (!assessment.canAcceptCheckpoint) this.#stopAtSafeCheckpoint();
  }

  async flushPendingWrites(): Promise<void> {
    await this.#writeQueue;
  }

  #attachRecorderEvents(recorder: RecorderLike): void {
    this.#stopPromise = new Promise((resolve) => {
      this.#resolveStop = resolve;
    });
    recorder.addEventListener('dataavailable', (event) => {
      if (!this.#acceptingData || event.data.size === 0) return;
      this.#writeQueue = this.#writeQueue
        .then(() => this.#persistEmittedBlob(event.data))
        .catch((error: unknown) => this.#unitFailed(error));
    });
    recorder.addEventListener('error', () => {
      this.#acceptingData = false;
      void this.#failCapture(
        new Error('The browser recorder reported a capture failure.'),
        'capture_failed',
      ).finally(() => {
        if (recorder.state === 'recording') recorder.stop();
      });
    });
    recorder.addEventListener('stop', () => {
      void this.#writeQueue.finally(() => this.#finishStoppedRecording());
    });
  }

  async #persistEmittedBlob(blob: Blob): Promise<void> {
    for (let offset = 0; offset < blob.size; offset += MAX_AUDIO_CHUNK_BYTES) {
      if (!this.#acceptingData) break;
      const unit = blob.slice(
        offset,
        Math.min(blob.size, offset + MAX_AUDIO_CHUNK_BYTES),
        blob.type,
      );
      await this.#persistUnit(unit);
      const assessment = await this.#assessStorage(true);
      this.#applyStorageAssessment(assessment);
      if (!assessment.canAcceptCheckpoint) {
        this.#stopAtSafeCheckpoint();
        break;
      }
    }
  }

  async #persistUnit(blob: Blob): Promise<void> {
    const recording = this.#recording;
    if (recording === undefined)
      throw new Error('The local recording manifest is missing.');
    const index = recording.nextChunkIndex;
    const protectedChunk = await this.#dependencies.protectChunk(
      recording.recordingId,
      index,
      blob,
    );
    if (protectedChunk.byteSize > MAX_AUDIO_CHUNK_BYTES)
      throw new Error('A local recording unit exceeded the protocol bound.');
    const committedAt = this.#dependencies.now().toISOString();
    try {
      this.#recording = await this.#dependencies.storage.commitRecordingChunk(
        recording.recordingId,
        {
          recordingId: recording.recordingId,
          index,
          ownerId: recording.ownerId,
          schemaVersion: 1,
          byteSize: protectedChunk.byteSize,
          sha256: protectedChunk.sha256,
          mimeType: blob.type || recording.mimeType,
          capturedAt: committedAt,
          nonce: protectedChunk.nonce,
          ciphertext: protectedChunk.ciphertext,
        },
        committedAt,
      );
    } catch (error) {
      throw new LocalRecordingPersistenceError(error);
    }
    this.#snapshot.value = {
      ...this.#snapshot.value,
      lastSavedChunkIndex: index,
    };
  }

  async #assessStorage(evictAtLowSpace: boolean): Promise<StorageAssessment> {
    let estimate = await this.#estimateStorage();
    let assessment = this.#classifyEstimate(estimate);
    if (evictAtLowSpace && assessment.state === 'low') {
      await this.#dependencies.evictReadCache();
      estimate = await this.#estimateStorage();
      assessment = this.#classifyEstimate(estimate);
    }
    return assessment;
  }

  async #estimateStorage(): Promise<StorageEstimate | undefined> {
    try {
      return await this.#dependencies.storageManager?.estimate?.();
    } catch {
      return undefined;
    }
  }

  #classifyEstimate(estimate: StorageEstimate | undefined): StorageAssessment {
    if (
      !isFiniteEstimate(estimate?.quota) ||
      !isFiniteEstimate(estimate.usage)
    ) {
      return { state: 'unknown', canAcceptCheckpoint: true };
    }
    const remainingBytes = Math.max(0, estimate.quota - estimate.usage);
    const lowThreshold = Math.max(
      BROWSER_STORAGE_LOW_BYTES,
      estimate.quota * 0.1,
    );
    return {
      state: remainingBytes <= lowThreshold ? 'low' : 'available',
      canAcceptCheckpoint:
        remainingBytes >=
        MAX_AUDIO_CHUNK_BYTES + BROWSER_STORAGE_SAFETY_RESERVE_BYTES,
      remainingBytes,
    };
  }

  #applyStorageAssessment(assessment: StorageAssessment): void {
    this.#snapshot.value = {
      ...this.#snapshot.value,
      storageState: assessment.state,
      ...(assessment.remainingBytes === undefined
        ? {}
        : { remainingBytes: assessment.remainingBytes }),
    };
  }

  #stopAtSafeCheckpoint(): void {
    this.#acceptingData = false;
    if (this.#recorder?.state === 'recording') {
      this.#snapshot.value = {
        ...this.#snapshot.value,
        storageState: 'low',
        message:
          'Recording stopped at the last saved checkpoint because browser storage is low.',
      };
      this.#recorder.stop();
    }
  }

  async #storageFailed(error: unknown): Promise<void> {
    this.#acceptingData = false;
    await this.#failCapture(error, 'browser_storage_exhausted');
    if (this.#recorder?.state === 'recording') this.#recorder.stop();
  }

  async #unitFailed(error: unknown): Promise<void> {
    this.#acceptingData = false;
    if (storageCommitFailed(error)) {
      await this.#storageFailed(error);
      return;
    }
    await this.#failCapture(error, 'capture_failed');
    if (this.#recorder?.state === 'recording') this.#recorder.stop();
  }

  async #failCapture(
    error: unknown,
    errorCode: 'browser_storage_exhausted' | 'capture_failed',
  ): Promise<void> {
    const message =
      errorCode === 'browser_storage_exhausted'
        ? 'Browser storage is exhausted. The last saved checkpoint is preserved.'
        : captureFailureMessage(error);
    this.#snapshot.value = {
      ...this.#snapshot.value,
      phase: 'failed',
      storageState:
        errorCode === 'browser_storage_exhausted'
          ? 'exhausted'
          : this.#snapshot.value.storageState,
      errorCode,
      message,
    };
    if (this.#recording !== undefined) {
      this.#recording = {
        ...this.#recording,
        state:
          errorCode === 'browser_storage_exhausted'
            ? 'browser_storage_exhausted'
            : 'failed',
        errorCode,
        retrySafe: this.#recording.nextChunkIndex > 0,
        updatedAt: this.#dependencies.now().toISOString(),
      };
      try {
        await this.#dependencies.storage.putRecording(this.#recording);
      } catch {
        // The reactive state still reports the failure when quota also blocks
        // the best-effort persistent metadata update.
      }
    }
  }

  async #finishStoppedRecording(): Promise<void> {
    stopTracks(this.#stream);
    this.#stream = undefined;
    this.#acceptingData = false;
    if (
      this.#recording !== undefined &&
      this.#snapshot.value.errorCode === undefined
    ) {
      this.#recording = {
        ...this.#recording,
        state: 'saved_locally',
        durationMilliseconds: Math.max(
          0,
          this.#dependencies.now().getTime() -
            new Date(this.#recording.capturedAt).getTime(),
        ).toString(),
        updatedAt: this.#dependencies.now().toISOString(),
      };
      try {
        await this.#dependencies.storage.putRecording(this.#recording);
        this.#snapshot.value = {
          ...this.#snapshot.value,
          phase: 'saved_locally',
        };
      } catch (error) {
        await this.#storageFailed(error);
      }
    }
    this.#recorder = undefined;
    this.#recording = undefined;
    this.#resolveStop?.();
    this.#resolveStop = undefined;
  }
}

export const browserCaptureController = new BrowserCaptureController();

export function useBrowserCaptureController() {
  return {
    snapshot: browserCaptureController.snapshot,
    start: (input: StartCaptureInput) => browserCaptureController.start(input),
    stop: () => browserCaptureController.stop(),
    checkStorage: () => browserCaptureController.checkStorage(),
  };
}
