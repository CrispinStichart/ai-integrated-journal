import { describe, expect, it } from 'vitest';

import {
  createPostgresTestContainer,
  createSyntheticJournalFixture,
  PGVECTOR_IMAGE,
  testSupportPackageName,
} from '../src/index.js';

describe('@journal/test-support operational shell', () => {
  it('exposes its package identity', () => {
    expect(testSupportPackageName).toBe('@journal/test-support');
  });

  it('creates deterministic, content-free synthetic fixtures', () => {
    expect(createSyntheticJournalFixture()).toEqual(
      createSyntheticJournalFixture(),
    );
    expect(
      createSyntheticJournalFixture({ journalDate: '2030-02-03' }),
    ).toEqual({
      journalDate: '2030-02-03',
      text: 'Synthetic journal fixture sentence.',
      audio: Uint8Array.from([0x52, 0x49, 0x46, 0x46]),
    });
  });

  it('configures an isolated pgvector PostgreSQL container', () => {
    const container = createPostgresTestContainer();

    expect(PGVECTOR_IMAGE).toBe('pgvector/pgvector:0.8.1-pg17-bookworm');
    expect(container).toBeInstanceOf(Object);
  });
});
