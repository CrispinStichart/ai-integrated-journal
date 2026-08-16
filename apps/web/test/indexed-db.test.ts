// @vitest-environment jsdom

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { IndexedDbMetadataStore } from '../src/storage/indexed-db';

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
});
