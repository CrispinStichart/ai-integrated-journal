import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

const DATABASE_VERSION = 2;
const METADATA_STORE = 'shell-metadata';
const OFFLINE_CONFIG_STORE = 'offline-config';
const OUTBOX_STORE = 'text-outbox';
const READ_CACHE_STORE = 'journal-read-cache';

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
        },
      },
    );
    return this.#connection;
  }
}

/** Kept as an alias for the Phase 1 shell API. */
export class IndexedDbMetadataStore extends JournalIndexedDb {}

export const browserMetadata = new JournalIndexedDb();
