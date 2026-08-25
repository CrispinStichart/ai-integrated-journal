import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createPostgresTestContainer } from '@journal/test-support';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SearchRepository,
  createDatabaseClient,
  migrateDatabase,
  migrationsFolder,
  type DatabaseClient,
} from '../src/index.js';

describe('lexical search forward migration', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let legacyMigrations: string;

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
    });
    legacyMigrations = await mkdtemp(
      path.join(tmpdir(), 'journal-search-legacy-'),
    );
    await mkdir(path.join(legacyMigrations, 'meta'));
    const journal = JSON.parse(
      await readFile(
        path.join(migrationsFolder, 'meta', '_journal.json'),
        'utf8',
      ),
    ) as { entries: Array<{ tag: string }> };
    const currentTag = '20260825031407_charming_deathstrike';
    const currentIndex = journal.entries.findIndex(
      ({ tag }) => tag === currentTag,
    );
    if (currentIndex < 0)
      throw new Error('Lexical search migration is missing.');
    const legacyEntries = journal.entries.slice(0, currentIndex);
    await writeFile(
      path.join(legacyMigrations, 'meta', '_journal.json'),
      `${JSON.stringify({ ...journal, entries: legacyEntries }, null, 2)}\n`,
    );
    const tags = new Set(legacyEntries.map(({ tag }) => tag));
    for (const fileName of await readdir(migrationsFolder)) {
      if (fileName.endsWith('.sql') && tags.has(fileName.slice(0, -4)))
        await copyFile(
          path.join(migrationsFolder, fileName),
          path.join(legacyMigrations, fileName),
        );
    }
    await migrateDatabase(client.database, legacyMigrations);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
    if (legacyMigrations !== undefined)
      await rm(legacyMigrations, { recursive: true, force: true });
  });

  it('[SEARCH-001][SEARCH-006][RET-007] backfills only current non-deleted exact revisions from a production-shaped prior schema', async () => {
    const owner = '019c5b90-0000-7000-8000-000000000501';
    const day = '019c5b90-0000-7000-8000-000000000502';
    const contribution = '019c5b90-0000-7000-8000-000000000503';
    const oldRevision = '019c5b90-0000-7000-8000-000000000504';
    const currentRevision = '019c5b90-0000-7000-8000-000000000505';
    await client.database.execute(sql`
      insert into journal."user" (id, display_name) values (${owner}::uuid, 'Legacy search owner')
    `);
    await client.database.execute(sql`
      insert into journal.journal_day (id, user_id, journal_date)
        values (${day}::uuid, ${owner}::uuid, '2026-08-24')
    `);
    await client.database.execute(sql`
      insert into journal.contribution (
        id, journal_day_id, author_id, source_type, captured_at, captured_timezone,
        journal_timezone, journal_date_assignment
      ) values (
        ${contribution}::uuid, ${day}::uuid, ${owner}::uuid, 'typed_text', now(),
        'UTC', 'UTC', 'default'
      )
    `);
    await client.database.execute(sql`
      insert into journal.contribution_revision (
        id, contribution_id, revision, text, authority, author_id, content_hash
      ) values
        (${oldRevision}::uuid, ${contribution}::uuid, 1, 'obsolete firefly wording',
          'manual', ${owner}::uuid, ${'a'.repeat(64)}),
        (${currentRevision}::uuid, ${contribution}::uuid, 2, 'current firefly wording',
          'manual', ${owner}::uuid, ${'b'.repeat(64)})
    `);
    await client.database.execute(sql`
      update journal.contribution set current_revision_id = ${currentRevision}::uuid,
        current_revision = 2 where id = ${contribution}::uuid
    `);

    await migrateDatabase(client.database);
    const repository = new SearchRepository(client.database);
    const current = await repository.lexical({
      ownerId: owner,
      query: 'fire',
      filters: {},
      limit: 10,
    });
    expect(current).toEqual([
      expect.objectContaining({
        sourceRevisionId: currentRevision,
        sourceRevision: 2,
      }),
    ]);
    expect(
      await repository.lexical({
        ownerId: owner,
        query: 'obsolete',
        filters: {},
        limit: 10,
      }),
    ).toHaveLength(0);
  });
});
