import { PostgreSqlContainer } from '@testcontainers/postgresql';

export const testSupportPackageName = '@journal/test-support' as const;

export const PGVECTOR_IMAGE = 'pgvector/pgvector:0.8.1-pg17-bookworm' as const;

export function createPostgresTestContainer(): PostgreSqlContainer {
  return new PostgreSqlContainer(PGVECTOR_IMAGE)
    .withDatabase('journal_test')
    .withUsername('journal_test')
    .withPassword('journal_test')
    .withCopyContentToContainer([
      {
        content: 'CREATE EXTENSION IF NOT EXISTS vector;\n',
        target: '/docker-entrypoint-initdb.d/001-enable-vector.sql',
      },
    ]);
}

export type SyntheticJournalFixture = Readonly<{
  journalDate: string;
  text: string;
  audio: Uint8Array;
}>;

/** Content-free, deterministic data safe for tests, logs, and snapshots. */
export function createSyntheticJournalFixture(
  overrides: Partial<SyntheticJournalFixture> = {},
): SyntheticJournalFixture {
  return Object.freeze({
    journalDate: overrides.journalDate ?? '2026-01-15',
    text: overrides.text ?? 'Synthetic journal fixture sentence.',
    audio: overrides.audio ?? Uint8Array.from([0x52, 0x49, 0x46, 0x46]),
  });
}
