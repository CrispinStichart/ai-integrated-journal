// @vitest-environment jsdom

import { MAX_AUDIO_CHUNK_BYTES } from '@journal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUDIO_MIME_CANDIDATES,
  BrowserCaptureController,
  CAPTURE_TIMESLICE_MILLISECONDS,
  type BrowserCaptureDependencies,
} from '../src/recording/capture-controller';
import type {
  EncryptedRecordingChunkRecord,
  LocalRecordingRecord,
} from '../src/storage/indexed-db';

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

  async putRecording(record: LocalRecordingRecord): Promise<void> {
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
  } = {},
) {
  const calls: string[] = [];
  const storage = new MemoryCaptureStorage();
  storage.failAtIndex = options.failAtIndex;
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
      return stream;
    },
    isTypeSupported: (mimeType) =>
      (options.supportedMimeTypes ?? AUDIO_MIME_CANDIDATES).includes(mimeType),
    createRecorder: (_stream, mimeType) => {
      calls.push(`recorder-${mimeType ?? 'default'}`);
      return recorder as unknown as MediaRecorder;
    },
    protectChunk: async (_recordingId, _index, chunk) => ({
      byteSize: chunk.size,
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

afterEach(() => vi.restoreAllMocks());

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
});
