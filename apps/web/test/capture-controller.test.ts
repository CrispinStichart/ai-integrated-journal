// @vitest-environment jsdom

import 'fake-indexeddb/auto';

import { MAX_AUDIO_CHUNK_BYTES } from '@journal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUDIO_MIME_CANDIDATES,
  browserCaptureController,
  BrowserCaptureController,
  CAPTURE_TIMESLICE_MILLISECONDS,
  type BrowserCaptureDependencies,
  useBrowserCaptureController,
} from '../src/recording/capture-controller';
import { offlineJournal } from '../src/journal/offline';
import type {
  EncryptedRecordingChunkRecord,
  LocalRecordingRecord,
} from '../src/storage/indexed-db';
import { browserMetadata } from '../src/storage/indexed-db';

const OWNER_ID = '018f0000-0000-7000-8000-000000000001';
const DAY_ID = '018f0000-0000-7000-8000-000000000002';
const IDS = [
  '018f0000-0000-7000-8000-000000000003',
  '018f0000-0000-7000-8000-000000000004',
  '018f0000-0000-7000-8000-000000000005',
] as const;
const SHA256 = 'a'.repeat(64);

class MemoryCaptureStorage {
  readonly recordings = new Map<string, LocalRecordingRecord>();
  readonly chunks: EncryptedRecordingChunkRecord[] = [];
  failAtIndex: number | undefined;
  putRecordingError: Error | undefined;

  async putRecording(record: LocalRecordingRecord): Promise<void> {
    if (this.putRecordingError !== undefined) throw this.putRecordingError;
    this.recordings.set(record.recordingId, { ...record });
  }

  async commitRecordingChunk(
    recordingId: string,
    chunk: EncryptedRecordingChunkRecord,
    committedAt: string,
  ): Promise<LocalRecordingRecord> {
    if (chunk.index === this.failAtIndex)
      throw new DOMException('Browser quota exhausted', 'QuotaExceededError');
    const recording = this.recordings.get(recordingId);
    if (recording === undefined) throw new Error('missing recording');
    const updated: LocalRecordingRecord = {
      ...recording,
      nextChunkIndex: recording.nextChunkIndex + 1,
      totalBytes: (
        BigInt(recording.totalBytes) + BigInt(chunk.byteSize)
      ).toString(),
      updatedAt: committedAt,
      lastSavedAt: committedAt,
    };
    this.chunks.push(chunk);
    this.recordings.set(recordingId, updated);
    return updated;
  }
}

class FakeMediaRecorder extends EventTarget {
  readonly mimeType: string;
  state: RecordingState = 'inactive';
  timeslice: number | undefined;

  constructor(mimeType: string) {
    super();
    this.mimeType = mimeType;
  }

  start(timeslice?: number): void {
    this.timeslice = timeslice;
    this.state = 'recording';
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.dispatchEvent(new Event('stop'));
  }

  emit(blob: Blob): void {
    const event = new Event('dataavailable');
    Object.defineProperty(event, 'data', { value: blob });
    this.dispatchEvent(event);
  }

  fail(): void {
    this.dispatchEvent(new Event('error'));
  }
}

function highCapacity(): StorageEstimate {
  return { quota: 2 * 1024 ** 3, usage: 0 };
}

function createHarness(
  options: {
    supportedMimeTypes?: readonly string[];
    recorderMimeType?: string;
    estimates?: StorageEstimate[];
    estimateError?: Error;
    failAtIndex?: number;
    protectedByteSize?: number;
    putRecordingError?: Error;
    permissionError?: Error;
  } = {},
) {
  const calls: string[] = [];
  const storage = new MemoryCaptureStorage();
  storage.failAtIndex = options.failAtIndex;
  storage.putRecordingError = options.putRecordingError;
  const recorder = new FakeMediaRecorder(
    options.recorderMimeType ??
      options.supportedMimeTypes?.[0] ??
      AUDIO_MIME_CANDIDATES[0],
  );
  const track = { stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  let idIndex = 0;
  let estimateIndex = 0;
  const estimates = options.estimates ?? [highCapacity()];
  const evictReadCache = vi.fn().mockResolvedValue(undefined);
  const persist = vi.fn().mockResolvedValue(true);
  const dependencies: BrowserCaptureDependencies = {
    storage,
    storageManager: {
      persist,
      estimate: vi.fn(async () => {
        if (options.estimateError !== undefined) throw options.estimateError;
        const value = estimates[Math.min(estimateIndex, estimates.length - 1)];
        estimateIndex += 1;
        return value ?? highCapacity();
      }),
    },
    createId: () => {
      calls.push(`id-${idIndex}`);
      const id = IDS[idIndex];
      idIndex += 1;
      if (id === undefined) throw new Error('unexpected identity request');
      return id;
    },
    now: () => new Date('2026-08-22T12:00:00.000Z'),
    captureTimezone: () => 'UTC',
    getUserMedia: async () => {
      calls.push('permission');
      if (options.permissionError !== undefined) throw options.permissionError;
      return stream;
    },
    isTypeSupported: (mimeType) =>
      (options.supportedMimeTypes ?? AUDIO_MIME_CANDIDATES).includes(mimeType),
    createRecorder: (_stream, mimeType) => {
      calls.push(`recorder-${mimeType ?? 'default'}`);
      return recorder as unknown as MediaRecorder;
    },
    protectChunk: async (_recordingId, _index, chunk) => ({
      byteSize: options.protectedByteSize ?? chunk.size,
      sha256: SHA256,
      nonce: 'nonce',
      ciphertext: new ArrayBuffer(chunk.size + 16),
    }),
    evictReadCache,
  };
  return {
    calls,
    controller: new BrowserCaptureController(dependencies),
    evictReadCache,
    persist,
    recorder,
    storage,
    track,
  };
}

const captureInput = {
  ownerId: OWNER_ID,
  proposedJournalDayId: DAY_ID,
  journalDate: '2026-08-22',
  journalTimezone: 'UTC',
  journalDateAssignment: 'default',
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser capture controller', () => {
  it('[CAP-002][CAP-004][CAP-005] allocates stable identities before capture, negotiates MIME, and persists bounded timeslices', async () => {
    const harness = createHarness();

    await expect(harness.controller.start(captureInput)).resolves.toEqual({
      recordingId: IDS[0],
      contributionId: IDS[1],
      uploadId: IDS[2],
    });

    expect(harness.calls.slice(0, 4)).toEqual([
      'id-0',
      'id-1',
      'id-2',
      'permission',
    ]);
    expect(harness.calls[4]).toBe(`recorder-${AUDIO_MIME_CANDIDATES[0]}`);
    expect(harness.recorder.timeslice).toBe(CAPTURE_TIMESLICE_MILLISECONDS);
    expect(harness.persist).toHaveBeenCalledOnce();
    await expect(harness.controller.start(captureInput)).rejects.toThrow(
      'already active',
    );
    await harness.controller.checkStorage();
    harness.recorder.emit(new Blob([], { type: AUDIO_MIME_CANDIDATES[0] }));
    await harness.controller.flushPendingWrites();
    expect(harness.storage.chunks).toHaveLength(0);

    harness.recorder.emit(
      new Blob([new Uint8Array(MAX_AUDIO_CHUNK_BYTES + 3)], {
        type: AUDIO_MIME_CANDIDATES[0],
      }),
    );
    await harness.controller.flushPendingWrites();
    expect(harness.storage.chunks.map((chunk) => chunk.byteSize)).toEqual([
      MAX_AUDIO_CHUNK_BYTES,
      3,
    ]);
    expect(harness.storage.chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(harness.controller.snapshot.value.lastSavedChunkIndex).toBe(1);
    expect(harness.storage.recordings.get(IDS[0])).toMatchObject({
      contributionId: IDS[1],
      uploadId: IDS[2],
      proposedJournalDayId: DAY_ID,
      journalDate: '2026-08-22',
      capturedTimezone: 'UTC',
      journalDateAssignment: 'default',
    });

    await harness.controller.stop();
    expect(harness.controller.snapshot.value.phase).toBe('saved_locally');
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.storage.recordings.get(IDS[0])?.state).toBe('saved_locally');
    await harness.controller.checkStorage();
  });

  it('[CAP-005] falls back to the browser default when neither preferred Opus MIME type is supported', async () => {
    const harness = createHarness({
      supportedMimeTypes: [],
      recorderMimeType: 'audio/mp4',
    });

    await harness.controller.start(captureInput);

    expect(harness.calls).toContain('recorder-default');
    expect(harness.storage.recordings.get(IDS[0])).toMatchObject({
      mimeType: 'audio/mp4',
    });
    expect(harness.storage.recordings.get(IDS[0])).not.toHaveProperty('codec');
    harness.recorder.emit(new Blob(['default format bytes']));
    await harness.controller.flushPendingWrites();
    expect(harness.storage.chunks[0]?.mimeType).toBe('audio/mp4');
    await harness.controller.stop();
  });

  it('[CAP-002][CAP-003][CAP-005][CAP-006] preserves the committed prefix and exposes hard storage exhaustion', async () => {
    const harness = createHarness({ failAtIndex: 1 });
    await harness.controller.start(captureInput);

    harness.recorder.emit(
      new Blob(['checkpoint zero'], { type: 'audio/webm' }),
    );
    await harness.controller.flushPendingWrites();
    harness.recorder.emit(new Blob(['checkpoint one'], { type: 'audio/webm' }));
    await harness.controller.flushPendingWrites();

    expect(harness.storage.chunks).toHaveLength(1);
    expect(harness.storage.chunks[0]?.index).toBe(0);
    expect(harness.controller.snapshot.value).toMatchObject({
      phase: 'failed',
      storageState: 'exhausted',
      errorCode: 'browser_storage_exhausted',
      lastSavedChunkIndex: 0,
    });
    expect(harness.storage.recordings.get(IDS[0])).toMatchObject({
      recordingId: IDS[0],
      contributionId: IDS[1],
      nextChunkIndex: 1,
      state: 'browser_storage_exhausted',
    });
  });

  it('[CAP-005][CAP-006] evicts read cache and stops at the last checkpoint before the safety reserve', async () => {
    const unsafe = {
      quota: 1024 ** 3,
      usage: 1024 ** 3 - (MAX_AUDIO_CHUNK_BYTES + 32 * 1024 ** 2 - 1),
    };
    const harness = createHarness({
      estimates: [highCapacity(), unsafe, unsafe],
    });
    await harness.controller.start(captureInput);

    harness.recorder.emit(new Blob(['safe prefix'], { type: 'audio/webm' }));
    await harness.controller.flushPendingWrites();
    await vi.waitFor(() => {
      expect(harness.controller.snapshot.value.phase).toBe('saved_locally');
    });

    expect(harness.evictReadCache).toHaveBeenCalledOnce();
    expect(harness.controller.snapshot.value).toMatchObject({
      phase: 'saved_locally',
      storageState: 'low',
      lastSavedChunkIndex: 0,
    });
    expect(harness.storage.chunks).toHaveLength(1);
  });

  it('[CAP-005][CAP-006] refuses capture before permission when quota cannot hold one safe checkpoint', async () => {
    const unsafe = {
      quota: 1024 ** 3,
      usage: 1024 ** 3 - 16 * 1024 ** 2,
    };
    const harness = createHarness({ estimates: [unsafe, unsafe] });

    await expect(harness.controller.start(captureInput)).rejects.toThrow(
      'cannot safely hold',
    );

    expect(harness.calls).toEqual(['id-0', 'id-1', 'id-2']);
    expect(harness.evictReadCache).toHaveBeenCalledOnce();
    expect(harness.controller.snapshot.value).toMatchObject({
      phase: 'failed',
      storageState: 'exhausted',
      errorCode: 'browser_storage_exhausted',
    });
    expect(harness.storage.recordings.size).toBe(0);
  });

  it('[CAP-005] continues with explicitly unknown availability when quota estimation fails', async () => {
    const harness = createHarness({
      estimateError: new Error('estimate unavailable'),
    });
    await harness.controller.start(captureInput);
    expect(harness.controller.snapshot.value.storageState).toBe('unknown');
    await harness.controller.stop();
  });

  it('[CAP-005] releases permission immediately when the recorder reports no usable MIME type', async () => {
    const harness = createHarness({ recorderMimeType: '   ' });

    await expect(harness.controller.start(captureInput)).rejects.toThrow(
      'did not report an audio MIME type',
    );

    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.storage.recordings.size).toBe(0);
    expect(harness.controller.snapshot.value).toMatchObject({
      phase: 'failed',
      errorCode: 'capture_failed',
    });
    await expect(harness.controller.stop()).resolves.toBeUndefined();
  });

  it('[CAP-002][CAP-006] exposes microphone permission denial without persisting a false recording', async () => {
    const harness = createHarness({
      permissionError: new DOMException(
        'Microphone permission denied.',
        'NotAllowedError',
      ),
    });

    await expect(harness.controller.start(captureInput)).rejects.toThrow(
      'Microphone permission denied',
    );

    expect(harness.calls).toEqual(['id-0', 'id-1', 'id-2', 'permission']);
    expect(harness.storage.recordings.size).toBe(0);
    expect(harness.controller.snapshot.value).toMatchObject({
      phase: 'failed',
      recordingId: IDS[0],
      contributionId: IDS[1],
      errorCode: 'capture_failed',
      message: 'Microphone permission was denied. Allow access and try again.',
    });
    expect(harness.track.stop).not.toHaveBeenCalled();
  });

  it('[CAP-003][CAP-006] treats an aborted IndexedDB manifest transaction as exhausted storage', async () => {
    const harness = createHarness({
      putRecordingError: new DOMException(
        'IndexedDB transaction aborted.',
        'AbortError',
      ),
    });

    await expect(harness.controller.start(captureInput)).rejects.toThrow(
      'IndexedDB transaction aborted',
    );

    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.controller.snapshot.value).toMatchObject({
      phase: 'failed',
      storageState: 'exhausted',
      errorCode: 'browser_storage_exhausted',
    });
  });

  it('[CAP-004][CAP-006] rejects a protected checkpoint that violates the protocol byte bound', async () => {
    const harness = createHarness({
      protectedByteSize: MAX_AUDIO_CHUNK_BYTES + 1,
    });
    await harness.controller.start(captureInput);

    harness.recorder.emit(new Blob(['oversized protected unit']));
    await harness.controller.flushPendingWrites();
    await vi.waitFor(() => {
      expect(harness.controller.snapshot.value).toMatchObject({
        phase: 'failed',
        errorCode: 'capture_failed',
        message: 'A local recording unit exceeded the protocol bound.',
      });
    });

    expect(harness.storage.chunks).toHaveLength(0);
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it('[CAP-003][CAP-006] records a MediaRecorder failure without replacing stable identities', async () => {
    const harness = createHarness();
    await harness.controller.start(captureInput);

    harness.recorder.fail();
    await vi.waitFor(() => {
      expect(harness.controller.snapshot.value.phase).toBe('failed');
      expect(harness.storage.recordings.get(IDS[0])?.state).toBe('failed');
      expect(harness.track.stop).toHaveBeenCalledOnce();
    });

    expect(harness.controller.snapshot.value).toMatchObject({
      recordingId: IDS[0],
      contributionId: IDS[1],
      errorCode: 'capture_failed',
    });
  });

  it('[CAP-002][CAP-004][CAP-005] uses the browser adapters to persist an encrypted checkpoint and stop the microphone', async () => {
    class BrowserMediaRecorder extends EventTarget {
      static instance: BrowserMediaRecorder | undefined;

      static isTypeSupported(mimeType: string): boolean {
        return mimeType === AUDIO_MIME_CANDIDATES[0];
      }

      readonly mimeType: string;
      state: RecordingState = 'inactive';

      constructor(
        _stream: MediaStream,
        options?: Readonly<{ mimeType?: string }>,
      ) {
        super();
        this.mimeType = options?.mimeType ?? 'audio/mp4';
        BrowserMediaRecorder.instance = this;
      }

      start(): void {
        this.state = 'recording';
      }

      stop(): void {
        this.state = 'inactive';
        this.dispatchEvent(new Event('stop'));
      }

      emit(blob: Blob): void {
        const event = new Event('dataavailable');
        Object.defineProperty(event, 'data', { value: blob });
        this.dispatchEvent(event);
      }
    }

    const track = { stop: vi.fn() };
    const stream = {
      getTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const persist = vi.fn().mockResolvedValue(true);
    const estimate = vi
      .fn()
      .mockResolvedValueOnce({ quota: 1024 ** 3, usage: 960 * 1024 ** 2 })
      .mockResolvedValue(highCapacity());
    const protectChunk = vi
      .spyOn(offlineJournal, 'protectRecordingChunk')
      .mockImplementation(async (_recordingId, _index, chunk) => ({
        byteSize: chunk.size,
        sha256: SHA256,
        nonce: 'browser-adapter-nonce',
        ciphertext: new ArrayBuffer(chunk.size + 16),
      }));
    const clearReadCache = vi
      .spyOn(offlineJournal, 'clearReadCache')
      .mockResolvedValue(undefined);
    vi.stubGlobal('MediaRecorder', BrowserMediaRecorder);
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia },
      onLine: true,
      storage: { estimate, persist },
    });

    try {
      const controller = new BrowserCaptureController();
      const identities = await controller.start(captureInput);
      const recorder = BrowserMediaRecorder.instance;
      if (recorder === undefined)
        throw new Error('MediaRecorder was not made.');
      recorder.emit(
        new Blob(['encrypted checkpoint'], {
          type: AUDIO_MIME_CANDIDATES[0],
        }),
      );
      await controller.flushPendingWrites();
      await controller.stop();

      expect(persist).toHaveBeenCalledOnce();
      expect(clearReadCache).toHaveBeenCalledOnce();
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
      expect(protectChunk).toHaveBeenCalledWith(
        identities.recordingId,
        0,
        expect.any(Blob),
      );
      expect(track.stop).toHaveBeenCalledOnce();
      await expect(
        browserMetadata.getRecording(identities.recordingId),
      ).resolves.toMatchObject({
        state: 'saved_locally',
        nextChunkIndex: 1,
        totalBytes: '20',
      });
    } finally {
      await browserMetadata.destroy();
    }
  });

  it('[CAP-002][CAP-003][CAP-005] remains stable across a long sequence of microphone checkpoints', async () => {
    const harness = createHarness();
    await harness.controller.start(captureInput);

    for (let index = 0; index < 256; index += 1) {
      harness.recorder.emit(
        new Blob([`checkpoint-${index}`], {
          type: AUDIO_MIME_CANDIDATES[0],
        }),
      );
    }
    await harness.controller.flushPendingWrites();
    await harness.controller.stop();

    expect(harness.storage.chunks).toHaveLength(256);
    expect(harness.storage.chunks.at(-1)?.index).toBe(255);
    expect(harness.storage.recordings.get(IDS[0])).toMatchObject({
      nextChunkIndex: 256,
      state: 'saved_locally',
    });
    expect(harness.controller.snapshot.value).toMatchObject({
      phase: 'saved_locally',
      lastSavedChunkIndex: 255,
    });
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it('[CAP-002] exposes the shared capture lifecycle through the composable API', async () => {
    const start = vi
      .spyOn(browserCaptureController, 'start')
      .mockResolvedValue({
        recordingId: IDS[0],
        contributionId: IDS[1],
        uploadId: IDS[2],
      });
    const stop = vi
      .spyOn(browserCaptureController, 'stop')
      .mockResolvedValue(undefined);
    const checkStorage = vi
      .spyOn(browserCaptureController, 'checkStorage')
      .mockResolvedValue(undefined);
    const capture = useBrowserCaptureController();

    expect(capture.snapshot).toBe(browserCaptureController.snapshot);
    await expect(capture.start(captureInput)).resolves.toEqual({
      recordingId: IDS[0],
      contributionId: IDS[1],
      uploadId: IDS[2],
    });
    await capture.checkStorage();
    await capture.stop();

    expect(start).toHaveBeenCalledWith(captureInput);
    expect(checkStorage).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
