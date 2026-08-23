import { createHash } from 'node:crypto';
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
  createDatabaseClient,
  migrateDatabase,
  migrationsFolder,
  transcriptSegments,
  type DatabaseClient,
} from '../src/index.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('transcript evidence forward migration', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let legacyMigrations: string;

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 2 },
    });
    legacyMigrations = await mkdtemp(
      path.join(tmpdir(), 'journal-legacy-migrations-'),
    );
    await mkdir(path.join(legacyMigrations, 'meta'));
    const journal = JSON.parse(
      await readFile(
        path.join(migrationsFolder, 'meta', '_journal.json'),
        'utf8',
      ),
    ) as { entries: Array<{ tag: string }> };
    const legacyEntries = journal.entries.slice(0, -1);
    await writeFile(
      path.join(legacyMigrations, 'meta', '_journal.json'),
      `${JSON.stringify({ ...journal, entries: legacyEntries }, null, 2)}\n`,
    );
    const legacyTags = new Set(legacyEntries.map(({ tag }) => tag));
    for (const fileName of await readdir(migrationsFolder)) {
      if (
        fileName.endsWith('.sql') &&
        legacyTags.has(fileName.slice(0, -'.sql'.length))
      ) {
        await copyFile(
          path.join(migrationsFolder, fileName),
          path.join(legacyMigrations, fileName),
        );
      }
    }
    await migrateDatabase(client.database, legacyMigrations);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
    if (legacyMigrations !== undefined) {
      await rm(legacyMigrations, { recursive: true, force: true });
    }
  });

  it('[DATA-027][PROV-003] backfills stable UTF-16 segment evidence for pre-existing transcript revisions', async () => {
    const ownerId = '019c5b90-0000-7000-8000-000000000301';
    const dayId = '019c5b90-0000-7000-8000-000000000302';
    const contributionId = '019c5b90-0000-7000-8000-000000000303';
    const recordingId = '019c5b90-0000-7000-8000-000000000304';
    const runId = '019c5b90-0000-7000-8000-000000000305';
    const rawTranscriptId = '019c5b90-0000-7000-8000-000000000306';
    const rawRevisionId = '019c5b90-0000-7000-8000-000000000307';
    const correctedTranscriptId = '019c5b90-0000-7000-8000-000000000308';
    const correctedRevisionId = '019c5b90-0000-7000-8000-000000000309';
    const transcriptText = 'A 😊 journal';
    const segment = [
      {
        text: '😊 journal',
        timing: { status: 'known', startMs: 100, endMs: 500 },
        words: { status: 'unknown' },
      },
    ];
    const createdAt = new Date('2026-08-22T23:59:00.000Z');

    await client.database.execute(sql`
      insert into journal."user" (id, display_name)
      values (${ownerId}::uuid, 'Synthetic migration owner')
    `);
    await client.database.execute(sql`
      insert into journal.journal_day (id, user_id, journal_date)
      values (${dayId}::uuid, ${ownerId}::uuid, '2026-08-22')
    `);
    await client.database.execute(sql`
      insert into journal.contribution (
        id, journal_day_id, source_type, author_id, captured_at,
        captured_timezone, journal_timezone, journal_date_assignment
      ) values (
        ${contributionId}::uuid, ${dayId}::uuid, 'recording', ${ownerId}::uuid,
        ${createdAt}, 'UTC', 'UTC', 'default'
      )
    `);
    await client.database.execute(sql`
      insert into journal.recording (id, contribution_id, mime_type)
      values (${recordingId}::uuid, ${contributionId}::uuid, 'audio/webm')
    `);
    await client.database.execute(sql`
      insert into journal.transcription_run (
        id, recording_id, attempt, status, input_audio_sha256,
        input_fingerprint, completed_at
      ) values (
        ${runId}::uuid, ${recordingId}::uuid, 1, 'succeeded',
        ${'a'.repeat(64)}, ${'b'.repeat(64)}, ${createdAt}
      )
    `);
    await client.database.execute(sql`
      insert into journal.transcript (
        id, recording_id, layer, current_revision_id, current_revision
      ) values
        (${rawTranscriptId}::uuid, ${recordingId}::uuid, 'raw_stt', ${rawRevisionId}::uuid, 1),
        (${correctedTranscriptId}::uuid, ${recordingId}::uuid, 'corrected', ${correctedRevisionId}::uuid, 1)
    `);
    await client.database.execute(sql`
      insert into journal.transcript_revision (
        id, transcript_id, source_run_id, source_revision_id, revision, text,
        segments, language, timing_availability, authority, content_hash,
        created_at
      ) values
        (
          ${rawRevisionId}::uuid, ${rawTranscriptId}::uuid, ${runId}::uuid,
          null, 1, ${transcriptText}, ${JSON.stringify(segment)}::jsonb,
          '{"status":"unknown"}'::jsonb,
          '{"segments":"known","words":"unknown"}'::jsonb,
          'generated', ${sha256(transcriptText)}, ${createdAt}
        ),
        (
          ${correctedRevisionId}::uuid, ${correctedTranscriptId}::uuid, null,
          ${rawRevisionId}::uuid, 1, ${transcriptText},
          ${JSON.stringify(segment)}::jsonb, '{"status":"unknown"}'::jsonb,
          '{"segments":"known","words":"unknown"}'::jsonb,
          'generated', ${sha256(transcriptText)}, ${createdAt}
        )
    `);

    await migrateDatabase(client.database);

    const persisted = await client.database
      .select()
      .from(transcriptSegments)
      .orderBy(transcriptSegments.transcriptRevisionId);
    expect(persisted).toHaveLength(2);
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transcriptRevisionId: rawRevisionId,
          sourceSegmentId: null,
          startUtf16: 2,
          endUtf16: 12,
          startMs: 100n,
          endMs: 500n,
          quote: '😊 journal',
          quoteHash: sha256('😊 journal'),
        }),
        expect.objectContaining({
          transcriptRevisionId: correctedRevisionId,
          sourceSegmentId: persisted.find(
            ({ transcriptRevisionId }) =>
              transcriptRevisionId === rawRevisionId,
          )?.id,
          startUtf16: 2,
          endUtf16: 12,
        }),
      ]),
    );
    expect(persisted.every(({ id }) => id[14] === '7')).toBe(true);
  });
});
