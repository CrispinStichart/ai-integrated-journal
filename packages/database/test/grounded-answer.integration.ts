import { createHash } from 'node:crypto';

import { createUuidV7 } from '@journal/domain';
import { createPostgresTestContainer } from '@journal/test-support';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  GroundedAnswerIdempotencyConflictError,
  GroundedAnswerRepository,
  contributionRevisions,
  contributions,
  createDatabaseClient,
  journalDays,
  migrateDatabase,
  searchFragments,
  users,
  type DatabaseClient,
} from '../src/index.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('grounded answer persistence', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let repository: GroundedAnswerRepository;
  let timestamp = 2_100_000;
  const id = () => createUuidV7<'grounded-fixture'>({ timestamp: timestamp++ });
  const ownerId = id();
  const otherOwnerId = id();
  const dayId = id();
  const contributionId = id();
  const revisionId = id();
  const now = new Date('2026-08-25T04:00:00.000Z');

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
    });
    await migrateDatabase(client.database);
    repository = new GroundedAnswerRepository(client.database);
    await client.database
      .insert(users)
      .values({ id: ownerId, displayName: 'Grounded owner' });
    await client.database
      .insert(journalDays)
      .values({ id: dayId, userId: ownerId, journalDate: '2026-08-25' });
    await client.database.insert(contributions).values({
      id: contributionId,
      journalDayId: dayId,
      authorId: ownerId,
      sourceType: 'typed_text',
      capturedAt: now,
      capturedTimezone: 'UTC',
      journalTimezone: 'UTC',
      journalDateAssignment: 'default',
    });
    await client.database.insert(contributionRevisions).values({
      id: revisionId,
      contributionId,
      revision: 1,
      text: 'I took a carefully documented morning walk.',
      authority: 'manual',
      authorId: ownerId,
      contentHash: hash('I took a carefully documented morning walk.'),
    });
    await client.database
      .update(contributions)
      .set({ currentRevisionId: revisionId, currentRevision: 1 })
      .where(eq(contributions.id, contributionId));
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('[SEARCH-003][SEARCH-006][SEARCH-007][STATE-004][SEC-001][SEC-007] atomically snapshots current owner evidence and enqueues identifiers only', async () => {
    const [fragment] = await client.database
      .select({ id: searchFragments.id })
      .from(searchFragments)
      .where(eq(searchFragments.sourceRevisionId, revisionId));
    if (fragment === undefined)
      throw new Error('Search fragment was not indexed.');
    const send = vi.fn(
      async (_queue, _payload, options: { id?: string }) => options.id ?? null,
    );
    const boss = { send } as unknown as PgBoss;
    const request = {
      question: 'What did I do in the morning?',
      mode: 'lexical' as const,
      layers: ['typed_text' as const],
    };
    const created = await repository.create({
      boss,
      ownerId,
      request,
      requestHash: hash(JSON.stringify(request)),
      idempotencyKey: 'grounded-integration-1',
      retrieval: { requestedMode: 'lexical', effectiveMode: 'lexical' },
      fragmentIds: [fragment.id],
      createId: id,
      now,
    });
    expect(created.created).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const queuedPayload = send.mock.calls[0]?.[1];
    expect(queuedPayload).toMatchObject({
      operation: 'grounded_answer',
      identifiers: { answerId: created.answerId, ownerId },
    });
    expect(JSON.stringify(queuedPayload)).not.toContain('morning walk');
    const loaded = await repository.loadForOwner(created.answerId, ownerId);
    expect(loaded).toMatchObject({
      status: 'queued',
      allCitationsCurrent: true,
      citations: [
        {
          sourceRevisionId: revisionId,
          retrievedQuote: 'I took a carefully documented morning walk.',
        },
      ],
    });
    await expect(
      repository.loadForOwner(created.answerId, otherOwnerId),
    ).resolves.toBeUndefined();

    const replay = await repository.create({
      boss,
      ownerId,
      request,
      requestHash: hash(JSON.stringify(request)),
      idempotencyKey: 'grounded-integration-1',
      retrieval: { requestedMode: 'lexical', effectiveMode: 'lexical' },
      fragmentIds: [fragment.id],
      createId: id,
      now,
    });
    expect(replay).toEqual({ answerId: created.answerId, created: false });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(
      repository.create({
        boss,
        ownerId,
        request: { ...request, question: 'Different question?' },
        requestHash: hash('different'),
        idempotencyKey: 'grounded-integration-1',
        retrieval: { requestedMode: 'lexical', effectiveMode: 'lexical' },
        fragmentIds: [fragment.id],
      }),
    ).rejects.toBeInstanceOf(GroundedAnswerIdempotencyConflictError);

    const citationId = loaded?.citations[0]?.citationId;
    if (citationId === undefined)
      throw new Error('Citation was not persisted.');
    await repository.complete({
      answerId: created.answerId,
      status: 'succeeded',
      synthesis: 'You took a morning walk.',
      citationIds: [citationId],
      effectiveMessagesHash: 'b'.repeat(64),
      provider: { id: 'fake' },
      model: { id: 'fake-v1' },
      effectiveConfiguration: { parameters: {}, fingerprint: 'c'.repeat(64) },
      usage: { status: 'unknown' },
      processingTimeMilliseconds: 5n,
      rawResponse: {
        id: id(),
        blobKey: `provider-responses/structured_generation/${id()}/raw.response`,
        mediaType: 'application/json',
        byteSize: 20n,
        sha256: 'd'.repeat(64),
        retention: 'days_30',
        expiresAt: new Date('2026-09-24T04:00:00.000Z'),
      },
      now: new Date('2026-08-25T04:00:01.000Z'),
    });
    await expect(
      repository.loadForOwner(created.answerId, ownerId),
    ).resolves.toMatchObject({
      status: 'succeeded',
      synthesis: 'You took a morning walk.',
      citations: [{ citedOrdinal: 0 }],
    });

    const replacementId = id();
    await client.database.insert(contributionRevisions).values({
      id: replacementId,
      contributionId,
      revision: 2,
      text: 'Replacement current revision.',
      authority: 'manual',
      authorId: ownerId,
      contentHash: hash('Replacement current revision.'),
    });
    await client.database
      .update(contributions)
      .set({ currentRevisionId: replacementId, currentRevision: 2 })
      .where(eq(contributions.id, contributionId));
    await expect(
      repository.loadForOwner(created.answerId, ownerId),
    ).resolves.toMatchObject({ allCitationsCurrent: false });
  });

  it('[SEARCH-007] records immediate insufficient support without a provider job when retrieval is empty', async () => {
    const send = vi.fn();
    const created = await repository.create({
      boss: { send } as unknown as PgBoss,
      ownerId,
      request: { question: 'Unsupported?', mode: 'hybrid' },
      requestHash: hash('unsupported'),
      idempotencyKey: 'grounded-integration-empty',
      retrieval: { requestedMode: 'hybrid', effectiveMode: 'lexical' },
      fragmentIds: [],
      createId: id,
      now,
    });
    await expect(
      repository.loadForOwner(created.answerId, ownerId),
    ).resolves.toMatchObject({
      status: 'insufficient_support',
      citations: [],
    });
    expect(send).not.toHaveBeenCalled();
  });
});
