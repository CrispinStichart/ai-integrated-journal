// @vitest-environment jsdom

import 'fake-indexeddb/auto';

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { MAX_AUDIO_CHUNK_BYTES } from '@journal/contracts';
import { MAX_WEBM_INPUT_BYTES } from '@journal/webm-duration-fix';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  recordingSyncController,
  RecordingSyncController,
  isWebmRecording,
  splitFinalizedBytes,
  type RecordingSyncDependencies,
  useRecordingSyncController,
} from '../src/recording/sync-controller';
import {
  browserMetadata,
  JournalIndexedDb,
  type LocalRecordingRecord,
} from '../src/storage/indexed-db';
import { RecordingApiError } from '../src/recording/api';

const OWNER_ID = '018f0000-0000-7000-8000-000000000001';
const DAY_ID = '018f0000-0000-7000-8000-000000000002';
const RECORDING_ID = '018f0000-0000-7000-8000-000000000003';
const CONTRIBUTION_ID = '018f0000-0000-7000-8000-000000000004';
const UPLOAD_ID = '018f0000-0000-7000-8000-000000000005';
const MOVED_DAY_ID = '018f0000-0000-7000-8000-000000000006';
const NOW = '2026-08-22T12:00:10.000Z';
const encoder = new TextEncoder();
const stores: JournalIndexedDb[] = [];

function hex(value: Uint8Array): string {
  return bytesToHex(sha256(value));
}

function remote(persistenceState: 'uploading' | 'prepared' | 'durable') {
  return {
    id: RECORDING_ID,
    contributionId: CONTRIBUTION_ID,
    uploadId: UPLOAD_ID,
    mimeType: 'audio/webm;codecs=opus',
    codec: 'opus',
    persistenceState,
    ...(persistenceState === 'uploading'
      ? {}
      : { byteSize: '6', sha256: hex(encoder.encode('onetwo')) }),
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
}

function localRecording(
  overrides: Partial<LocalRecordingRecord> = {},
): LocalRecordingRecord {
  return {
    recordingId: RECORDING_ID,
    contributionId: CONTRIBUTION_ID,
    uploadId: UPLOAD_ID,
    proposedJournalDayId: DAY_ID,
    ownerId: OWNER_ID,
    schemaVersion: 1,
    mimeType: 'audio/webm;codecs=opus',
    codec: 'opus',
    capturedAt: '2026-08-22T12:00:00.000Z',
    capturedTimezone: 'UTC',
    journalTimezone: 'UTC',
    journalDate: '2026-08-22',
    journalDateAssignment: 'default',
    state: 'saved_locally',
    nextChunkIndex: 2,
    totalBytes: '6',
    durationMilliseconds: '10000',
    createdAt: '2026-08-22T12:00:00.000Z',
    updatedAt: NOW,
    ...overrides,
  };
}

async function populate(store: JournalIndexedDb, recording = localRecording()) {
  await store.putRecording({
    ...recording,
    nextChunkIndex: 0,
    totalBytes: '0',
  });
  for (const [index, text] of ['one', 'two'].entries()) {
    const bytes = encoder.encode(text);
    await store.commitRecordingChunk(
      RECORDING_ID,
      {
        recordingId: RECORDING_ID,
        index,
        ownerId: OWNER_ID,
        schemaVersion: 1,
        byteSize: bytes.byteLength,
        sha256: hex(bytes),
        mimeType: recording.mimeType,
        capturedAt: NOW,
        nonce: 'test-only',
        ciphertext: bytes.buffer.slice(0),
      },
      NOW,
    );
  }
  await store.putRecording(recording);
}

function harness(overrides: Partial<RecordingSyncDependencies> = {}) {
  const store = new JournalIndexedDb(`recording-sync-${crypto.randomUUID()}`);
  stores.push(store);
  const dependencies: RecordingSyncDependencies = {
    storage: store,
    now: () => new Date(NOW),
    online: () => true,
    decryptChunk: async (chunk) => chunk.ciphertext.slice(0),
    protectChunk: vi.fn(async (_recordingId, _index, blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        byteSize: bytes.byteLength,
        sha256: hex(bytes),
        nonce: 'test-only-finalized',
        ciphertext: bytes.buffer.slice(0),
      };
    }),
    finalizeWebm: vi.fn(async (bytes) => ({ bytes, changed: false })),
    create: vi.fn().mockResolvedValue(remote('uploading')),
    status: vi.fn().mockResolvedValue({
      recording: remote('uploading'),
      acceptedIndexes: [0],
    }),
    upload: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(remote('durable')),
    retryFinalization: vi.fn().mockResolvedValue(remote('durable')),
    move: vi.fn().mockResolvedValue(undefined),
    createId: () => MOVED_DAY_ID,
    ...overrides,
  };
  return {
    controller: new RecordingSyncController(dependencies),
    dependencies,
    store,
  };
}

afterEach(async () => {
  await Promise.all(stores.map((store) => store.destroy()));
  stores.length = 0;
  vi.unstubAllGlobals();
});

describe('recording synchronization', () => {
  it('[CAP-003] detects WebM only from a normalized MIME type and EBML signature', () => {
    const signature = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x00);

    expect(isWebmRecording(' Audio/WebM ; codecs=opus ', signature)).toBe(true);
    expect(isWebmRecording('audio/ogg', signature)).toBe(false);
    expect(
      isWebmRecording('audio/webm;codecs=opus', Uint8Array.of(1, 2, 3, 4)),
    ).toBe(false);
  });

  it('[CAP-003][CAP-004] deterministically splits finalized bytes at the protocol bound', () => {
    const bytes = new Uint8Array(MAX_AUDIO_CHUNK_BYTES + 3);
    for (let index = 0; index < bytes.byteLength; index += 1)
      bytes[index] = index % 251;

    const first = splitFinalizedBytes(bytes);
    const second = splitFinalizedBytes(bytes);
    expect(first.map((chunk) => chunk.byteLength)).toEqual([
      MAX_AUDIO_CHUNK_BYTES,
      3,
    ]);
    expect(first.map(hex)).toEqual(second.map(hex));
    expect(first[0]?.[0]).toBe(bytes[0]);
    expect(first[1]).toEqual(bytes.slice(MAX_AUDIO_CHUNK_BYTES));
  });

  it('[CAP-002][CAP-003][CAP-004][AC-002] resumes only missing checkpoints and cleans up only after durable confirmation', async () => {
    let confirmFinalize!: (value: ReturnType<typeof remote>) => void;
    const finalizePending = new Promise<ReturnType<typeof remote>>(
      (resolve) => {
        confirmFinalize = resolve;
      },
    );
    const finalize = vi.fn().mockReturnValue(finalizePending);
    const { controller, dependencies, store } = harness({ finalize });
    await populate(store);
    await controller.initialize(OWNER_ID, 'csrf-token');

    const resuming = controller.resume();
    const duplicateResume = controller.resume();
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());

    expect(dependencies.create).toHaveBeenCalledOnce();
    expect(dependencies.upload).toHaveBeenCalledOnce();
    expect(dependencies.upload).toHaveBeenCalledWith(
      RECORDING_ID,
      1,
      hex(encoder.encode('two')),
      expect.anything(),
      'csrf-token',
      expect.anything(),
    );
    expect(
      (vi.mocked(dependencies.upload).mock.calls[0]?.[3] as ArrayBuffer)
        .byteLength,
    ).toBe(3);
    expect(
      await store.listRecordingChunks(OWNER_ID, RECORDING_ID),
    ).toHaveLength(2);
    const summary = finalize.mock.calls[0]?.[1];
    expect(summary).toMatchObject({
      chunkCount: '2',
      totalBytes: '6',
      finalSha256: hex(encoder.encode('onetwo')),
      manifestSha256: hex(
        encoder.encode(
          `0:3:${hex(encoder.encode('one'))}\n1:3:${hex(encoder.encode('two'))}\n`,
        ),
      ),
    });

    confirmFinalize(remote('durable'));
    await Promise.all([resuming, duplicateResume]);
    expect(finalize).toHaveBeenCalledOnce();
    expect(await store.listRecordingChunks(OWNER_ID, RECORDING_ID)).toEqual([]);
    await expect(store.getRecording(RECORDING_ID)).resolves.toMatchObject({
      state: 'transcription_pending',
      serverPersistenceState: 'durable',
      durableAt: NOW,
    });
  });

  it('[CAP-002][CAP-003][CAP-004][AC-002] reopens an interrupted upload and completes the same durable recording without duplication', async () => {
    const interrupted = harness({
      upload: vi.fn().mockRejectedValue(new TypeError('connection closed')),
    });
    await populate(interrupted.store);
    await interrupted.controller.initialize(OWNER_ID, 'csrf-token');
    await interrupted.controller.resume();

    await expect(
      interrupted.store.getRecording(RECORDING_ID),
    ).resolves.toMatchObject({
      recordingId: RECORDING_ID,
      contributionId: CONTRIBUTION_ID,
      serverCreated: true,
      state: 'failed',
      retrySafe: true,
      syncErrorCode: 'network_unavailable',
    });
    expect(
      await interrupted.store.listRecordingChunks(OWNER_ID, RECORDING_ID),
    ).toHaveLength(2);

    const createAfterReopen = vi.fn();
    const uploadAfterReopen = vi.fn().mockResolvedValue(undefined);
    const finalizeAfterReopen = vi.fn().mockResolvedValue(remote('durable'));
    const reopened = new RecordingSyncController({
      ...interrupted.dependencies,
      create: createAfterReopen,
      status: vi.fn().mockResolvedValue({
        recording: remote('uploading'),
        acceptedIndexes: [0],
      }),
      upload: uploadAfterReopen,
      finalize: finalizeAfterReopen,
    });
    await reopened.initialize(OWNER_ID, 'new-csrf-token');
    expect(reopened.recordings.value).toMatchObject([
      {
        recordingId: RECORDING_ID,
        state: 'failed',
        retrySafe: true,
      },
    ]);
    await reopened.resume();

    expect(createAfterReopen).not.toHaveBeenCalled();
    expect(uploadAfterReopen).toHaveBeenCalledOnce();
    expect(uploadAfterReopen).toHaveBeenCalledWith(
      RECORDING_ID,
      1,
      hex(encoder.encode('two')),
      expect.anything(),
      'new-csrf-token',
      expect.anything(),
    );
    expect(
      (uploadAfterReopen.mock.calls[0]?.[3] as ArrayBuffer).byteLength,
    ).toBe(3);
    expect(finalizeAfterReopen).toHaveBeenCalledOnce();
    await expect(
      interrupted.store.getRecording(RECORDING_ID),
    ).resolves.toMatchObject({
      recordingId: RECORDING_ID,
      contributionId: CONTRIBUTION_ID,
      state: 'transcription_pending',
      serverPersistenceState: 'durable',
    });
    expect(
      await interrupted.store.listRecordingChunks(OWNER_ID, RECORDING_ID),
    ).toEqual([]);
  });

  it('[CAP-002][CAP-003][CAP-004] finalizes a complete ordered WebM once and uploads protected deterministic chunks', async () => {
    const original = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 10, 11, 12);
    const finalizedBytes = encoder.encode('finalized-webm');
    let confirmFinalize!: (value: ReturnType<typeof remote>) => void;
    const finalizeRequest = vi.fn().mockReturnValue(
      new Promise<ReturnType<typeof remote>>((resolve) => {
        confirmFinalize = resolve;
      }),
    );
    const finalizeWebm = vi.fn().mockResolvedValue({
      bytes: finalizedBytes,
      changed: true,
    });
    const { controller, dependencies, store } = harness({
      finalize: finalizeRequest,
      finalizeWebm,
      status: vi.fn().mockResolvedValue({
        recording: remote('uploading'),
        acceptedIndexes: [],
      }),
    });
    await store.putRecording(
      localRecording({ nextChunkIndex: 0, totalBytes: '0' }),
    );
    for (const [index, bytes] of [
      original.slice(0, 2),
      original.slice(2),
    ].entries()) {
      await store.commitRecordingChunk(
        RECORDING_ID,
        {
          recordingId: RECORDING_ID,
          index,
          ownerId: OWNER_ID,
          schemaVersion: 1,
          byteSize: bytes.byteLength,
          sha256: hex(bytes),
          mimeType: 'audio/webm;codecs=opus',
          capturedAt: NOW,
          nonce: 'test-only',
          ciphertext: bytes.buffer.slice(0),
        },
        NOW,
      );
    }
    await controller.initialize(OWNER_ID, 'csrf-token');

    const resuming = controller.resume();
    await vi.waitFor(() => expect(finalizeRequest).toHaveBeenCalledOnce());

    expect(finalizeWebm).toHaveBeenCalledOnce();
    expect(finalizeWebm).toHaveBeenCalledWith(original);
    expect(dependencies.protectChunk).toHaveBeenCalledOnce();
    expect(dependencies.upload).toHaveBeenCalledWith(
      RECORDING_ID,
      0,
      hex(finalizedBytes),
      expect.any(ArrayBuffer),
      'csrf-token',
      expect.anything(),
    );
    expect(
      hex(
        new Uint8Array(
          vi.mocked(dependencies.upload).mock.calls[0]?.[3] as ArrayBuffer,
        ),
      ),
    ).toBe(hex(finalizedBytes));
    expect(finalizeRequest).toHaveBeenCalledWith(
      RECORDING_ID,
      expect.objectContaining({
        chunkCount: '1',
        totalBytes: String(finalizedBytes.byteLength),
        finalSha256: hex(finalizedBytes),
        manifestSha256: hex(
          encoder.encode(
            `0:${finalizedBytes.byteLength}:${hex(finalizedBytes)}\n`,
          ),
        ),
      }),
      'csrf-token',
      expect.anything(),
    );
    expect(
      await store.listRecordingChunks(OWNER_ID, RECORDING_ID),
    ).toHaveLength(2);

    confirmFinalize(remote('durable'));
    await resuming;
    expect(await store.listRecordingChunks(OWNER_ID, RECORDING_ID)).toEqual([]);
  });

  it('[CAP-003][CAP-004] leaves an already-valid WebM on the original checkpoint path', async () => {
    const original = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 9, 8, 7);
    const finalizeWebm = vi.fn(async (bytes: Uint8Array) => ({
      bytes,
      changed: false,
    }));
    const { controller, dependencies, store } = harness({
      finalizeWebm,
      status: vi.fn().mockResolvedValue({
        recording: remote('uploading'),
        acceptedIndexes: [],
      }),
    });
    await store.putRecording(
      localRecording({ nextChunkIndex: 0, totalBytes: '0' }),
    );
    await store.commitRecordingChunk(
      RECORDING_ID,
      {
        recordingId: RECORDING_ID,
        index: 0,
        ownerId: OWNER_ID,
        schemaVersion: 1,
        byteSize: original.byteLength,
        sha256: hex(original),
        mimeType: 'audio/webm;codecs=opus',
        capturedAt: NOW,
        nonce: 'test-only',
        ciphertext: original.buffer.slice(0),
      },
      NOW,
    );
    await controller.initialize(OWNER_ID, 'csrf-token');
    await controller.resume();

    expect(finalizeWebm).toHaveBeenCalledOnce();
    expect(dependencies.protectChunk).not.toHaveBeenCalled();
    expect(dependencies.upload).toHaveBeenCalledWith(
      RECORDING_ID,
      0,
      hex(original),
      expect.anything(),
      'csrf-token',
      expect.anything(),
    );
  });

  it('[CAP-003][CAP-006] makes WebM finalization failure recoverable and retains every checkpoint', async () => {
    const original = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 1);
    const { controller, dependencies, store } = harness({
      finalizeWebm: vi.fn().mockRejectedValue(new Error('invalid WebM')),
      status: vi.fn().mockResolvedValue({
        recording: remote('uploading'),
        acceptedIndexes: [],
      }),
    });
    await store.putRecording(
      localRecording({ nextChunkIndex: 0, totalBytes: '0' }),
    );
    await store.commitRecordingChunk(
      RECORDING_ID,
      {
        recordingId: RECORDING_ID,
        index: 0,
        ownerId: OWNER_ID,
        schemaVersion: 1,
        byteSize: original.byteLength,
        sha256: hex(original),
        mimeType: 'audio/webm',
        capturedAt: NOW,
        nonce: 'test-only',
        ciphertext: original.buffer.slice(0),
      },
      NOW,
    );
    await controller.initialize(OWNER_ID, 'csrf-token');
    await controller.resume();

    expect(dependencies.upload).not.toHaveBeenCalled();
    expect(dependencies.finalize).not.toHaveBeenCalled();
    await expect(store.getRecording(RECORDING_ID)).resolves.toMatchObject({
      state: 'failed',
      retrySafe: true,
      syncErrorCode: 'audio_finalization_failed',
      syncErrorMessage:
        'The saved WebM could not be finalized. Your local recording is still available.',
    });
    expect(
      await store.listRecordingChunks(OWNER_ID, RECORDING_ID),
    ).toHaveLength(1);
  });

  it('[CAP-003][CAP-006] rejects oversized WebM before whole-file allocation or finalization', async () => {
    const original = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 1);
    const { controller, dependencies, store } = harness({
      status: vi.fn().mockResolvedValue({
        recording: remote('uploading'),
        acceptedIndexes: [],
      }),
    });
    await store.putRecording(
      localRecording({ nextChunkIndex: 0, totalBytes: '0' }),
    );
    await store.commitRecordingChunk(
      RECORDING_ID,
      {
        recordingId: RECORDING_ID,
        index: 0,
        ownerId: OWNER_ID,
        schemaVersion: 1,
        byteSize: MAX_WEBM_INPUT_BYTES + 1,
        sha256: hex(original),
        mimeType: 'audio/webm',
        capturedAt: NOW,
        nonce: 'test-only',
        ciphertext: original.buffer.slice(0),
      },
      NOW,
    );
    await store.putRecording(
      localRecording({
        nextChunkIndex: 1,
        totalBytes: String(MAX_WEBM_INPUT_BYTES + 1),
      }),
    );
    await controller.initialize(OWNER_ID, 'csrf-token');
    await controller.resume();

    expect(dependencies.finalizeWebm).not.toHaveBeenCalled();
    expect(dependencies.protectChunk).not.toHaveBeenCalled();
    expect(dependencies.upload).not.toHaveBeenCalled();
    await expect(store.getRecording(RECORDING_ID)).resolves.toMatchObject({
      state: 'failed',
      retrySafe: false,
      syncErrorCode: 'audio_finalization_too_large',
      syncErrorMessage:
        'This WebM is too large to finalize safely in this browser (maximum 128 MiB). Your local recording is still available.',
    });
    expect(
      await store.listRecordingChunks(OWNER_ID, RECORDING_ID),
    ).toHaveLength(1);
  });

  it('[CAP-003][CAP-006][SEC-001] aborts stale session requests and retains encrypted checkpoints on logout', async () => {
    let requestSignal: AbortSignal | undefined;
    const create = vi.fn(
      async (
        _input: Parameters<RecordingSyncDependencies['create']>[0],
        _csrfToken: string,
        signal?: AbortSignal,
      ) => {
        requestSignal = signal;
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    );
    const { controller, dependencies, store } = harness({ create });
    await populate(store);
    await controller.initialize(OWNER_ID, 'csrf-token');

    const resuming = controller.resume();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await controller.clearSession();
    await resuming;

    expect(requestSignal?.aborted).toBe(true);
    expect(controller.recordings.value).toEqual([]);
    expect(dependencies.status).not.toHaveBeenCalled();
    expect(dependencies.upload).not.toHaveBeenCalled();
    expect(dependencies.finalize).not.toHaveBeenCalled();
    await expect(store.getRecording(RECORDING_ID)).resolves.toMatchObject({
      state: 'uploading',
      retrySafe: true,
    });
    expect(
      await store.listRecordingChunks(OWNER_ID, RECORDING_ID),
    ).toHaveLength(2);
  });

  it('[CAP-003][CAP-006] gives retry a fresh cancellation scope after interrupting an in-flight upload', async () => {
    const signals: AbortSignal[] = [];
    const upload = vi
      .fn()
      .mockImplementationOnce(
        async (
          _recordingId: string,
          _index: number,
          _checksum: string,
          _bytes: ArrayBuffer,
          _csrfToken: string,
          signal?: AbortSignal,
        ) => {
          if (signal === undefined) throw new Error('Missing abort signal');
          signals.push(signal);
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });
        },
      )
      .mockImplementationOnce(
        async (
          _recordingId: string,
          _index: number,
          _checksum: string,
          _bytes: ArrayBuffer,
          _csrfToken: string,
          signal?: AbortSignal,
        ) => {
          if (signal === undefined) throw new Error('Missing abort signal');
          signals.push(signal);
        },
      );
    const { controller, store } = harness({ upload });
    await populate(store);
    await controller.initialize(OWNER_ID, 'csrf-token');

    const resuming = controller.resume();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    await controller.retry(RECORDING_ID);
    await resuming;

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await expect(store.getRecording(RECORDING_ID)).resolves.toMatchObject({
      state: 'transcription_pending',
      serverPersistenceState: 'durable',
    });
  });

  it('[CAP-003][CAP-006] preserves checkpoints and suppresses unsafe retry after a checksum conflict', async () => {
    const upload = vi
      .fn()
      .mockRejectedValue(
        new RecordingApiError('Conflicting checkpoint bytes.', 409, 'conflict'),
      );
    const { controller, store } = harness({ upload });
    await populate(store);
    await controller.initialize(OWNER_ID, 'csrf-token');
    await controller.resume();

    await expect(store.getRecording(RECORDING_ID)).resolves.toMatchObject({
      state: 'failed',
      retrySafe: false,
      syncErrorCode: 'conflict',
    });
    expect(
      await store.listRecordingChunks(OWNER_ID, RECORDING_ID),
    ).toHaveLength(2);
    await expect(controller.retry(RECORDING_ID)).rejects.toThrow(
      'conflicts with durable data',
    );
  });

  it('[CAP-007][AC-040] reassigns local and server-created audio without changing capture context', async () => {
    const { controller, dependencies, store } = harness();
    await populate(store, localRecording({ serverCreated: true }));
    await controller.initialize(OWNER_ID, 'csrf-token');

    await controller.move(RECORDING_ID, '2026-08-21');

    expect(dependencies.move).toHaveBeenCalledWith(
      CONTRIBUTION_ID,
      0,
      '2026-08-21',
      MOVED_DAY_ID,
      'csrf-token',
      `move-${MOVED_DAY_ID}`,
    );
    await expect(store.getRecording(RECORDING_ID)).resolves.toMatchObject({
      journalDate: '2026-08-21',
      journalDateAssignment: 'user_override',
      capturedAt: '2026-08-22T12:00:00.000Z',
      capturedTimezone: 'UTC',
    });
  });

  it('[CAP-003][CAP-004] pages accepted indexes and finalizes a default-format recording without re-uploading', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({
        recording: remote('uploading'),
        acceptedIndexes: [0],
        nextAfter: 0,
      })
      .mockResolvedValueOnce({
        recording: remote('uploading'),
        acceptedIndexes: [1],
      });
    const { controller, dependencies, store } = harness({ status });
    const defaultFormat = localRecording({
      serverCreated: true,
      mimeType: 'audio/ogg',
    });
    Reflect.deleteProperty(defaultFormat, 'codec');
    Reflect.deleteProperty(defaultFormat, 'durationMilliseconds');
    await populate(store, defaultFormat);
    await controller.initialize(OWNER_ID, 'csrf-token');
    await controller.resume();

    expect(status).toHaveBeenCalledTimes(2);
    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.finalizeWebm).not.toHaveBeenCalled();
    expect(dependencies.protectChunk).not.toHaveBeenCalled();
    expect(dependencies.upload).not.toHaveBeenCalled();
    expect(dependencies.finalize).toHaveBeenCalledWith(
      RECORDING_ID,
      expect.objectContaining({
        chunkCount: '2',
        totalBytes: '6',
        finalSha256: hex(encoder.encode('onetwo')),
        manifestSha256: hex(
          encoder.encode(
            `0:3:${hex(encoder.encode('one'))}\n1:3:${hex(encoder.encode('two'))}\n`,
          ),
        ),
      }),
      'csrf-token',
      expect.anything(),
    );
    expect(
      vi.mocked(dependencies.finalize).mock.calls[0]?.[1],
    ).not.toHaveProperty('durationMilliseconds');
  });

  it('[CAP-003][CAP-006] resumes prepared and retryable-failed server states but does nothing offline', async () => {
    const preparedHarness = harness({
      status: vi.fn().mockResolvedValue({
        recording: remote('prepared'),
        acceptedIndexes: [],
      }),
    });
    await populate(
      preparedHarness.store,
      localRecording({ state: 'uploading', serverCreated: true }),
    );
    await preparedHarness.controller.initialize(OWNER_ID, 'csrf-token');
    await preparedHarness.controller.resume();
    expect(
      preparedHarness.dependencies.retryFinalization,
    ).toHaveBeenCalledOnce();
    expect(preparedHarness.dependencies.finalize).not.toHaveBeenCalled();

    const failedHarness = harness({
      status: vi.fn().mockResolvedValue({
        recording: remote('durable'),
        acceptedIndexes: [],
      }),
    });
    await populate(
      failedHarness.store,
      localRecording({
        state: 'failed',
        serverCreated: true,
        retrySafe: true,
        syncErrorCode: 'network_unavailable',
      }),
    );
    await failedHarness.controller.initialize(OWNER_ID, 'csrf-token');
    await failedHarness.controller.resume();
    await expect(
      failedHarness.store.getRecording(RECORDING_ID),
    ).resolves.toMatchObject({ state: 'transcription_pending' });

    const offlineHarness = harness({ online: () => false });
    await offlineHarness.controller.refresh();
    await populate(offlineHarness.store);
    await offlineHarness.controller.initialize(OWNER_ID, 'csrf-token');
    await offlineHarness.controller.resume();
    expect(offlineHarness.dependencies.create).not.toHaveBeenCalled();
    await offlineHarness.controller.move(RECORDING_ID, '2026-08-20');
    expect(offlineHarness.dependencies.move).not.toHaveBeenCalled();
    await expect(
      offlineHarness.store.getRecording(RECORDING_ID),
    ).resolves.toMatchObject({ journalDate: '2026-08-20' });
  });

  it.each([503, 408, 429])(
    '[CAP-003][CAP-006] keeps API status %i failures retryable and clears the failure after a successful retry',
    async (status) => {
      const upload = vi
        .fn()
        .mockRejectedValueOnce(
          new RecordingApiError(
            `Upload temporarily unavailable (${status}).`,
            status,
            `upload_${status}`,
          ),
        )
        .mockResolvedValue(undefined);
      const { controller, store } = harness({ upload });
      await populate(store);
      await controller.initialize(OWNER_ID, 'csrf-token');
      await controller.resume();

      await expect(store.getRecording(RECORDING_ID)).resolves.toMatchObject({
        state: 'failed',
        retrySafe: true,
        syncErrorCode: `upload_${status}`,
        syncErrorMessage: `Upload temporarily unavailable (${status}).`,
      });

      await controller.retry(RECORDING_ID);
      const recovered = await store.getRecording(RECORDING_ID);
      expect(recovered).toMatchObject({
        state: 'transcription_pending',
        retrySafe: false,
        serverPersistenceState: 'durable',
      });
      expect(recovered).not.toHaveProperty('syncErrorCode');
      expect(recovered).not.toHaveProperty('syncErrorMessage');
    },
  );

  it('[CAP-003][CAP-006][SEC-003] distinguishes local corruption, an incomplete manifest, and a disconnected server', async () => {
    const corruptHarness = harness({
      decryptChunk: vi
        .fn()
        .mockRejectedValue(
          new DOMException('Authentication failed.', 'OperationError'),
        ),
    });
    await populate(corruptHarness.store);
    await corruptHarness.controller.initialize(OWNER_ID, 'csrf-token');
    await corruptHarness.controller.resume();
    await expect(
      corruptHarness.store.getRecording(RECORDING_ID),
    ).resolves.toMatchObject({
      state: 'failed',
      retrySafe: false,
      syncErrorCode: 'local_recording_corrupt',
      syncErrorMessage: 'A saved audio checkpoint could not be decrypted.',
    });

    const incompleteHarness = harness();
    await incompleteHarness.store.putRecording(
      localRecording({
        nextChunkIndex: 1,
        totalBytes: '3',
        serverCreated: true,
      }),
    );
    await incompleteHarness.controller.initialize(OWNER_ID, 'csrf-token');
    await incompleteHarness.controller.resume();
    await expect(
      incompleteHarness.store.getRecording(RECORDING_ID),
    ).resolves.toMatchObject({
      state: 'failed',
      retrySafe: false,
      syncErrorCode: 'local_recording_incomplete',
      syncErrorMessage: 'Audio checkpoint is missing at index 0.',
    });

    const disconnectedHarness = harness({
      status: vi.fn().mockRejectedValue(new TypeError('connection reset')),
    });
    await populate(disconnectedHarness.store);
    await disconnectedHarness.controller.initialize(OWNER_ID, 'csrf-token');
    await disconnectedHarness.controller.resume();
    await expect(
      disconnectedHarness.store.getRecording(RECORDING_ID),
    ).resolves.toMatchObject({
      state: 'failed',
      retrySafe: true,
      syncErrorCode: 'network_unavailable',
      syncErrorMessage:
        'Audio is still saved locally. Reconnect and retry the upload.',
    });
  });

  it("[CAP-003][SEC-001] never retries or moves another owner's local recording", async () => {
    const { controller, store } = harness();
    await controller.initialize(OWNER_ID, 'csrf-token');

    await expect(controller.retry(RECORDING_ID)).rejects.toThrow(
      'local recording is unavailable',
    );
    await store.putRecording(
      localRecording({
        ownerId: '018f0000-0000-7000-8000-000000000099',
        nextChunkIndex: 0,
        totalBytes: '0',
      }),
    );
    await expect(controller.move(RECORDING_ID, '2026-08-20')).rejects.toThrow(
      'local recording is unavailable',
    );
  });

  it('[CAP-003][CAP-007] exposes offline recovery through the browser-backed composable without contacting the server', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await browserMetadata.putRecording(
      localRecording({ nextChunkIndex: 0, totalBytes: '0' }),
    );

    try {
      const sync = useRecordingSyncController();
      expect(sync.recordings).toBe(recordingSyncController.recordings);
      await sync.initialize(OWNER_ID, 'csrf-token');
      expect(sync.recordings.value).toHaveLength(1);

      await sync.resume();
      await sync.move(RECORDING_ID, '2026-08-20');
      await sync.refresh();
      await expect(sync.retry('missing-recording')).rejects.toThrow(
        'local recording is unavailable',
      );

      expect(sync.recordings.value[0]).toMatchObject({
        recordingId: RECORDING_ID,
        journalDate: '2026-08-20',
        journalDateAssignment: 'user_override',
        state: 'saved_locally',
      });
      expect(sync.recordings.value[0]?.proposedJournalDayId).not.toBe(DAY_ID);
    } finally {
      await browserMetadata.destroy();
    }
  });
});
