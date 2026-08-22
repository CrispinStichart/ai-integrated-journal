import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

const DATABASE_VERSION = 4;
const METADATA_STORE = 'shell-metadata';
const OFFLINE_CONFIG_STORE = 'offline-config';
const OUTBOX_STORE = 'text-outbox';
const READ_CACHE_STORE = 'journal-read-cache';
const RECORDING_STORE = 'recordings';
const RECORDING_CHUNK_STORE = 'recording-chunks';

interface ShellMetadataRecord {
  key: string;
  value: unknown;
}

export interface OfflineConfigRecord {
  ownerId: string;
  salt: string;
  iterations: number;
  wrappedKeyNonce: string;
  wrappedKey: string;
}

export interface EncryptedOutboxRecord {
  id: string;
  ownerId: string;
  kind: 'create' | 'edit';
  stableId: string;
  schemaVersion: 1;
  createdAt: string;
  sequence: number;
  nonce: string;
  ciphertext: string;
  state: 'pending' | 'conflict';
}

export interface EncryptedJournalCacheRecord {
  key: string;
  ownerId: string;
  stableId: string;
  schemaVersion: 1;
  refreshedAt: string;
  lastAccessedAt: string;
  byteSize: number;
  nonce: string;
  ciphertext: string;
}

export type LocalRecordingState =
  | 'recording'
  | 'saved_locally'
  | 'uploading'
  | 'durable'
  | 'transcription_pending'
  | 'browser_storage_exhausted'
  | 'failed';

export interface LocalRecordingRecord {
  recordingId: string;
  contributionId: string;
  uploadId: string;
  proposedJournalDayId: string;
  ownerId: string;
  schemaVersion: 1;
  mimeType: string;
  codec?: string;
  capturedAt: string;
  capturedTimezone: string;
  journalTimezone: string;
  journalDate: string;
  journalDateAssignment: 'default' | 'user_override' | 'migration';
  state: LocalRecordingState;
  nextChunkIndex: number;
  totalBytes: string;
  durationMilliseconds?: string;
  uploadedChunkCount?: number;
  serverCreated?: boolean;
  serverPersistenceState?: 'uploading' | 'prepared' | 'durable';
  retrySafe?: boolean;
  syncErrorCode?: string;
  syncErrorMessage?: string;
  durableAt?: string;
  createdAt: string;
  updatedAt: string;
  lastSavedAt?: string;
  errorCode?: 'browser_storage_exhausted' | 'capture_failed';
}

export interface EncryptedRecordingChunkRecord {
  recordingId: string;
  index: number;
  ownerId: string;
  schemaVersion: 1;
  byteSize: number;
  sha256: string;
  mimeType: string;
  capturedAt: string;
  nonce: string;
  ciphertext: ArrayBuffer;
}

interface JournalBrowserSchema extends DBSchema {
  [METADATA_STORE]: { key: string; value: ShellMetadataRecord };
  [OFFLINE_CONFIG_STORE]: { key: string; value: OfflineConfigRecord };
  [OUTBOX_STORE]: {
    key: string;
    value: EncryptedOutboxRecord;
    indexes: { 'by-owner-created': [string, number] };
  };
  [READ_CACHE_STORE]: {
    key: string;
    value: EncryptedJournalCacheRecord;
    indexes: {
      'by-owner-access': [string, string];
      'by-owner-refresh': [string, string];
    };
  };
  [RECORDING_STORE]: {
    key: string;
    value: LocalRecordingRecord;
    indexes: { 'by-owner-created': [string, string] };
  };
  [RECORDING_CHUNK_STORE]: {
    key: [string, number];
    value: EncryptedRecordingChunkRecord;
    indexes: { 'by-owner-recording': [string, string, number] };
  };
}

function equalArrayBuffers(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

export interface BrowserMetadataStore {
  clear(): Promise<void>;
  close(): Promise<void>;
  delete(key: string): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export class JournalIndexedDb implements BrowserMetadataStore {
  readonly #databaseName: string;
  #connection: Promise<IDBPDatabase<JournalBrowserSchema>> | undefined;

  constructor(databaseName = 'journal-browser') {
    this.#databaseName = databaseName;
  }

  async clear(): Promise<void> {
    await (await this.#connect()).clear(METADATA_STORE);
  }

  async close(): Promise<void> {
    if (this.#connection) {
      (await this.#connection).close();
      this.#connection = undefined;
    }
  }

  async delete(key: string): Promise<void> {
    await (await this.#connect()).delete(METADATA_STORE, key);
  }

  async destroy(): Promise<void> {
    await this.close();
    await deleteDB(this.#databaseName);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await (await this.#connect()).get(METADATA_STORE, key))?.value as
      T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    await (await this.#connect()).put(METADATA_STORE, { key, value });
  }

  async getOfflineConfig(
    ownerId: string,
  ): Promise<OfflineConfigRecord | undefined> {
    return (await this.#connect()).get(OFFLINE_CONFIG_STORE, ownerId);
  }

  async putOfflineConfig(record: OfflineConfigRecord): Promise<void> {
    await (await this.#connect()).put(OFFLINE_CONFIG_STORE, record);
  }

  async putOutbox(record: EncryptedOutboxRecord): Promise<void> {
    await (await this.#connect()).put(OUTBOX_STORE, record);
  }

  async listOutbox(ownerId: string): Promise<EncryptedOutboxRecord[]> {
    return (await this.#connect()).getAllFromIndex(
      OUTBOX_STORE,
      'by-owner-created',
      IDBKeyRange.bound([ownerId, 0], [ownerId, Number.MAX_SAFE_INTEGER]),
    );
  }

  async deleteOutbox(id: string): Promise<void> {
    await (await this.#connect()).delete(OUTBOX_STORE, id);
  }

  async putJournalCache(record: EncryptedJournalCacheRecord): Promise<void> {
    await (await this.#connect()).put(READ_CACHE_STORE, record);
  }

  async getJournalCache(
    ownerId: string,
    stableId: string,
  ): Promise<EncryptedJournalCacheRecord | undefined> {
    return (await this.#connect()).get(
      READ_CACHE_STORE,
      `${ownerId}:${stableId}`,
    );
  }

  async listJournalCache(
    ownerId: string,
  ): Promise<EncryptedJournalCacheRecord[]> {
    return (await this.#connect()).getAllFromIndex(
      READ_CACHE_STORE,
      'by-owner-access',
      IDBKeyRange.bound([ownerId, ''], [ownerId, '\uffff']),
    );
  }

  async deleteJournalCache(key: string): Promise<void> {
    await (await this.#connect()).delete(READ_CACHE_STORE, key);
  }

  async clearJournalCache(ownerId: string): Promise<void> {
    const transaction = (await this.#connect()).transaction(
      READ_CACHE_STORE,
      'readwrite',
    );
    let cursor = await transaction.store
      .index('by-owner-access')
      .openCursor(IDBKeyRange.bound([ownerId, ''], [ownerId, '\uffff']));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await transaction.done;
  }

  async putRecording(record: LocalRecordingRecord): Promise<void> {
    await (await this.#connect()).put(RECORDING_STORE, record);
  }

  async getRecording(
    recordingId: string,
  ): Promise<LocalRecordingRecord | undefined> {
    return (await this.#connect()).get(RECORDING_STORE, recordingId);
  }

  async listRecordings(ownerId: string): Promise<LocalRecordingRecord[]> {
    return (await this.#connect()).getAllFromIndex(
      RECORDING_STORE,
      'by-owner-created',
      IDBKeyRange.bound([ownerId, ''], [ownerId, '\uffff']),
    );
  }

  async commitRecordingChunk(
    recordingId: string,
    chunk: EncryptedRecordingChunkRecord,
    committedAt: string,
  ): Promise<LocalRecordingRecord> {
    const database = await this.#connect();
    const transaction = database.transaction(
      [RECORDING_STORE, RECORDING_CHUNK_STORE],
      'readwrite',
    );
    const recordingStore = transaction.objectStore(RECORDING_STORE);
    const recording = await recordingStore.get(recordingId);
    if (recording === undefined) {
      throw new Error('The local recording manifest is missing.');
    }
    if (chunk.recordingId !== recordingId) {
      throw new Error('The recording chunk identity does not match.');
    }
    if (chunk.ownerId !== recording.ownerId) {
      throw new Error('The recording chunk owner does not match.');
    }
    if (chunk.index !== recording.nextChunkIndex) {
      throw new Error('Recording chunks must be committed in order.');
    }
    const updated: LocalRecordingRecord = {
      ...recording,
      nextChunkIndex: recording.nextChunkIndex + 1,
      totalBytes: (
        BigInt(recording.totalBytes) + BigInt(chunk.byteSize)
      ).toString(),
      updatedAt: committedAt,
      lastSavedAt: committedAt,
    };
    await transaction.objectStore(RECORDING_CHUNK_STORE).add(chunk);
    await recordingStore.put(updated);
    await transaction.done;

    const persisted = await database.get(RECORDING_CHUNK_STORE, [
      recordingId,
      chunk.index,
    ]);
    if (
      persisted === undefined ||
      persisted.byteSize !== chunk.byteSize ||
      persisted.sha256 !== chunk.sha256 ||
      persisted.nonce !== chunk.nonce ||
      !equalArrayBuffers(persisted.ciphertext, chunk.ciphertext)
    ) {
      throw new Error(
        'The recording chunk failed local read-back verification.',
      );
    }
    return updated;
  }

  async listRecordingChunks(
    ownerId: string,
    recordingId: string,
  ): Promise<EncryptedRecordingChunkRecord[]> {
    return (await this.#connect()).getAllFromIndex(
      RECORDING_CHUNK_STORE,
      'by-owner-recording',
      IDBKeyRange.bound(
        [ownerId, recordingId, 0],
        [ownerId, recordingId, Number.MAX_SAFE_INTEGER],
      ),
    );
  }

  async getRecordingChunk(
    recordingId: string,
    index: number,
  ): Promise<EncryptedRecordingChunkRecord | undefined> {
    return (await this.#connect()).get(RECORDING_CHUNK_STORE, [
      recordingId,
      index,
    ]);
  }

  async confirmRecordingDurable(
    recordingId: string,
    durableAt: string,
  ): Promise<LocalRecordingRecord> {
    const database = await this.#connect();
    const transaction = database.transaction(
      [RECORDING_STORE, RECORDING_CHUNK_STORE],
      'readwrite',
    );
    const recording = await transaction
      .objectStore(RECORDING_STORE)
      .get(recordingId);
    if (recording === undefined)
      throw new Error('The local recording manifest is missing.');
    const updated: LocalRecordingRecord = {
      ...recording,
      state: 'transcription_pending',
      serverCreated: true,
      serverPersistenceState: 'durable',
      uploadedChunkCount: recording.nextChunkIndex,
      retrySafe: false,
      durableAt,
      updatedAt: durableAt,
    };
    Reflect.deleteProperty(updated, 'syncErrorCode');
    Reflect.deleteProperty(updated, 'syncErrorMessage');
    await transaction.objectStore(RECORDING_STORE).put(updated);
    const chunkStore = transaction.objectStore(RECORDING_CHUNK_STORE);
    let cursor = await chunkStore.openCursor(
      IDBKeyRange.bound(
        [recordingId, 0],
        [recordingId, Number.MAX_SAFE_INTEGER],
      ),
    );
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await transaction.done;
    return updated;
  }

  #connect(): Promise<IDBPDatabase<JournalBrowserSchema>> {
    this.#connection ??= openDB<JournalBrowserSchema>(
      this.#databaseName,
      DATABASE_VERSION,
      {
        upgrade(database) {
          if (!database.objectStoreNames.contains(METADATA_STORE))
            database.createObjectStore(METADATA_STORE, { keyPath: 'key' });
          if (!database.objectStoreNames.contains(OFFLINE_CONFIG_STORE))
            database.createObjectStore(OFFLINE_CONFIG_STORE, {
              keyPath: 'ownerId',
            });
          if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
            const store = database.createObjectStore(OUTBOX_STORE, {
              keyPath: 'id',
            });
            store.createIndex('by-owner-created', ['ownerId', 'sequence']);
          }
          if (!database.objectStoreNames.contains(READ_CACHE_STORE)) {
            const store = database.createObjectStore(READ_CACHE_STORE, {
              keyPath: 'key',
            });
            store.createIndex('by-owner-access', ['ownerId', 'lastAccessedAt']);
            store.createIndex('by-owner-refresh', ['ownerId', 'refreshedAt']);
          }
          if (!database.objectStoreNames.contains(RECORDING_STORE)) {
            const store = database.createObjectStore(RECORDING_STORE, {
              keyPath: 'recordingId',
            });
            store.createIndex('by-owner-created', ['ownerId', 'createdAt']);
          }
          if (!database.objectStoreNames.contains(RECORDING_CHUNK_STORE)) {
            const store = database.createObjectStore(RECORDING_CHUNK_STORE, {
              keyPath: ['recordingId', 'index'],
            });
            store.createIndex('by-owner-recording', [
              'ownerId',
              'recordingId',
              'index',
            ]);
          }
        },
      },
    );
    return this.#connection;
  }
}

/** Kept as an alias for the Phase 1 shell API. */
export class IndexedDbMetadataStore extends JournalIndexedDb {}

export const browserMetadata = new JournalIndexedDb();
