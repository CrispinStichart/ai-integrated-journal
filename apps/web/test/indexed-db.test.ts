// @vitest-environment jsdom

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  IndexedDbMetadataStore,
  type LocalRecordingRecord,
} from '../src/storage/indexed-db';

const stores: IndexedDbMetadataStore[] = [];

afterEach(async () => {
  await Promise.all(stores.map((store) => store.destroy()));
  stores.length = 0;
});

function createStore(): IndexedDbMetadataStore {
  const store = new IndexedDbMetadataStore(
    `journal-test-${crypto.randomUUID()}`,
  );
  stores.push(store);
  return store;
}

describe('IndexedDB abstraction', () => {
  it('round trips structured shell metadata across connections', async () => {
    const databaseName = `journal-test-${crypto.randomUUID()}`;
    const first = new IndexedDbMetadataStore(databaseName);
    const second = new IndexedDbMetadataStore(databaseName);
    stores.push(first, second);

    await first.set('preferences', { reducedMotion: true });
    await first.close();

    await expect(
      second.get<{ reducedMotion: boolean }>('preferences'),
    ).resolves.toEqual({ reducedMotion: true });
  });

  it('deletes individual values and clears the store', async () => {
    const store = createStore();
    await store.set('one', 1);
    await store.set('two', 2);
    await store.delete('one');
    await expect(store.get('one')).resolves.toBeUndefined();

    await store.clear();
    await expect(store.get('two')).resolves.toBeUndefined();
  });

  it('[CAP-002][CAP-003][CAP-005] atomically commits ordered encrypted recording units and verifies read-back', async () => {
    const store = createStore();
    const recording: LocalRecordingRecord = {
      recordingId: '018f0000-0000-7000-8000-000000000001',
      contributionId: '018f0000-0000-7000-8000-000000000002',
      uploadId: '018f0000-0000-7000-8000-000000000003',
      proposedJournalDayId: '018f0000-0000-7000-8000-000000000004',
      ownerId: '018f0000-0000-7000-8000-000000000005',
      schemaVersion: 1,
      mimeType: 'audio/webm;codecs=opus',
      codec: 'opus',
      capturedAt: '2026-08-22T12:00:00.000Z',
      capturedTimezone: 'UTC',
      journalTimezone: 'UTC',
      journalDate: '2026-08-22',
      journalDateAssignment: 'default',
      state: 'recording',
      nextChunkIndex: 0,
      totalBytes: '0',
      createdAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:00:00.000Z',
    };
    await store.putRecording(recording);

    await store.commitRecordingChunk(
      recording.recordingId,
      {
        recordingId: recording.recordingId,
        index: 0,
        ownerId: recording.ownerId,
        schemaVersion: 1,
        byteSize: 3,
        sha256: 'a'.repeat(64),
        mimeType: recording.mimeType,
        capturedAt: '2026-08-22T12:00:05.000Z',
        nonce: 'nonce',
        ciphertext: Uint8Array.from([1, 2, 3, 4]).buffer,
      },
      '2026-08-22T12:00:05.000Z',
    );

    await expect(
      store.getRecording(recording.recordingId),
    ).resolves.toMatchObject({ nextChunkIndex: 1, totalBytes: '3' });
    await expect(
      store.listRecordingChunks(recording.ownerId, recording.recordingId),
    ).resolves.toMatchObject([{ index: 0, byteSize: 3, nonce: 'nonce' }]);

    await expect(
      store.commitRecordingChunk(
        recording.recordingId,
        {
          recordingId: recording.recordingId,
          index: 2,
          ownerId: recording.ownerId,
          schemaVersion: 1,
          byteSize: 1,
          sha256: 'b'.repeat(64),
          mimeType: recording.mimeType,
          capturedAt: '2026-08-22T12:00:10.000Z',
          nonce: 'nonce-2',
          ciphertext: Uint8Array.from([5]).buffer,
        },
        '2026-08-22T12:00:10.000Z',
      ),
    ).rejects.toThrow('in order');
    await expect(
      store.listRecordingChunks(recording.ownerId, recording.recordingId),
    ).resolves.toHaveLength(1);
  });

  it('[RET-006][RET-007][SEARCH-006] atomically purges cached reads, matching outbox recovery, and recording chunks from tombstones', async () => {
    const store = createStore();
    const ownerId = '018f0000-0000-7000-8000-000000000005';
    const contributionId = '018f0000-0000-7000-8000-000000000002';
    const recordingId = '018f0000-0000-7000-8000-000000000001';
    await store.putJournalCache({
      key: `${ownerId}:2026-08-22`,
      ownerId,
      stableId: '2026-08-22',
      schemaVersion: 1,
      refreshedAt: '2026-08-22T12:00:00.000Z',
      lastAccessedAt: '2026-08-22T12:00:00.000Z',
      byteSize: 20,
      nonce: 'cache-nonce',
      ciphertext: 'private-ciphertext',
    });
    await store.putOutbox({
      id: 'matching-outbox',
      ownerId,
      kind: 'edit',
      stableId: contributionId,
      schemaVersion: 1,
      createdAt: '2026-08-22T12:00:00.000Z',
      sequence: 1,
      nonce: 'outbox-nonce',
      ciphertext: 'private-ciphertext',
      state: 'pending',
    });
    await store.putOutbox({
      id: 'unrelated-outbox',
      ownerId,
      kind: 'edit',
      stableId: '018f0000-0000-7000-8000-000000000099',
      schemaVersion: 1,
      createdAt: '2026-08-22T12:01:00.000Z',
      sequence: 2,
      nonce: 'outbox-nonce-2',
      ciphertext: 'unrelated-ciphertext',
      state: 'pending',
    });
    const recording: LocalRecordingRecord = {
      recordingId,
      contributionId,
      uploadId: '018f0000-0000-7000-8000-000000000003',
      proposedJournalDayId: '018f0000-0000-7000-8000-000000000004',
      ownerId,
      schemaVersion: 1,
      mimeType: 'audio/webm',
      capturedAt: '2026-08-22T12:00:00.000Z',
      capturedTimezone: 'UTC',
      journalTimezone: 'UTC',
      journalDate: '2026-08-22',
      journalDateAssignment: 'default',
      state: 'recording',
      nextChunkIndex: 0,
      totalBytes: '0',
      createdAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:00:00.000Z',
    };
    await store.putRecording(recording);
    await store.commitRecordingChunk(
      recordingId,
      {
        recordingId,
        index: 0,
        ownerId,
        schemaVersion: 1,
        byteSize: 1,
        sha256: 'a'.repeat(64),
        mimeType: 'audio/webm',
        capturedAt: '2026-08-22T12:00:01.000Z',
        nonce: 'chunk-nonce',
        ciphertext: Uint8Array.from([1]).buffer,
      },
      '2026-08-22T12:00:01.000Z',
    );

    await store.purgeTombstones(ownerId, [
      {
        entityKind: 'contribution',
        entityId: contributionId,
        deletedAt: '2026-08-25T00:00:00.000Z',
        generation: 1,
      },
      {
        entityKind: 'recording_audio',
        entityId: recordingId,
        deletedAt: '2026-08-25T00:00:00.000Z',
        generation: 2,
      },
    ]);

    await expect(store.listJournalCache(ownerId)).resolves.toEqual([]);
    await expect(store.listOutbox(ownerId)).resolves.toMatchObject([
      { id: 'unrelated-outbox' },
    ]);
    await expect(store.getRecording(recordingId)).resolves.toBeUndefined();
    await expect(
      store.listRecordingChunks(ownerId, recordingId),
    ).resolves.toEqual([]);
  });
});
