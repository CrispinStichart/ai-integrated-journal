import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

const DATABASE_VERSION = 1;
const METADATA_STORE = 'shell-metadata';

interface ShellMetadataRecord {
  key: string;
  value: unknown;
}
interface JournalBrowserSchema extends DBSchema {
  [METADATA_STORE]: { key: string; value: ShellMetadataRecord };
}

export interface BrowserMetadataStore {
  clear(): Promise<void>;
  close(): Promise<void>;
  delete(key: string): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export class IndexedDbMetadataStore implements BrowserMetadataStore {
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

  #connect(): Promise<IDBPDatabase<JournalBrowserSchema>> {
    this.#connection ??= openDB<JournalBrowserSchema>(
      this.#databaseName,
      DATABASE_VERSION,
      {
        upgrade(database) {
          if (!database.objectStoreNames.contains(METADATA_STORE))
            database.createObjectStore(METADATA_STORE, { keyPath: 'key' });
        },
      },
    );
    return this.#connection;
  }
}

export const browserMetadata = new IndexedDbMetadataStore();
