// @vitest-environment jsdom

import 'fake-indexeddb/auto';

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RecordingSyncController,
  type RecordingSyncDependencies,
} from '../src/recording/sync-controller';
import {
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
});

describe('recording synchronization', () => {
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
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());

    expect(dependencies.create).toHaveBeenCalledOnce();
    expect(dependencies.upload).toHaveBeenCalledOnce();
    expect(dependencies.upload).toHaveBeenCalledWith(
      RECORDING_ID,
      1,
      hex(encoder.encode('two')),
      expect.anything(),
      'csrf-token',
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
    await resuming;
    expect(await store.listRecordingChunks(OWNER_ID, RECORDING_ID)).toEqual([]);
    await expect(store.getRecording(RECORDING_ID)).resolves.toMatchObject({
      state: 'transcription_pending',
      serverPersistenceState: 'durable',
      durableAt: NOW,
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
    const defaultFormat = localRecording({ serverCreated: true });
    Reflect.deleteProperty(defaultFormat, 'codec');
    Reflect.deleteProperty(defaultFormat, 'durationMilliseconds');
    await populate(store, defaultFormat);
    await controller.initialize(OWNER_ID, 'csrf-token');
    await controller.resume();

    expect(status).toHaveBeenCalledTimes(2);
    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.upload).not.toHaveBeenCalled();
    expect(dependencies.finalize).toHaveBeenCalledWith(
      RECORDING_ID,
      expect.not.objectContaining({ durationMilliseconds: expect.anything() }),
      'csrf-token',
    );
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
});
