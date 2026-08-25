import { createHash } from 'node:crypto';

import { createPostgresTestContainer } from '@journal/test-support';
import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SearchEmbeddingRepository,
  SearchRepository,
  contributionRevisions,
  contributions,
  createDatabaseClient,
  journalDays,
  migrateDatabase,
  provisionQueueFoundation,
  queueNames,
  searchEmbeddingRequests,
  seedDatabase,
  users,
  type DatabaseClient,
} from '../src/index.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('semantic lifecycle outbox and identifier-only queue', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let boss: PgBoss;
  const ownerId = '019c5b90-0000-7000-8000-000000000901';
  const dayId = '019c5b90-0000-7000-8000-000000000902';
  const contributionId = '019c5b90-0000-7000-8000-000000000903';
  const revisionId = '019c5b90-0000-7000-8000-000000000904';
  const jobId = '019c5b90-0000-7000-8000-000000000905';
  const cohortId = '019c5b90-0000-7000-8000-000000000906';
  const text =
    'Synthetic semantic lifecycle source without private fixture data.';

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
    await seedDatabase(client.database, 'test');
    boss = new PgBoss({
      application_name: '@journal/search-embedding-test',
      connectionString: container.getConnectionUri(),
      migrate: true,
      schedule: false,
      supervise: false,
      useListenNotify: true,
    });
    await provisionQueueFoundation(boss, client);
    await client.database.insert(users).values({
      id: ownerId,
      displayName: 'Semantic lifecycle owner',
    });
    await client.database.insert(journalDays).values({
      id: dayId,
      userId: ownerId,
      journalDate: '2026-08-25',
    });
    await client.database.insert(contributions).values({
      id: contributionId,
      journalDayId: dayId,
      authorId: ownerId,
      sourceType: 'typed_text',
      capturedAt: new Date('2026-08-25T00:00:00.000Z'),
      capturedTimezone: 'UTC',
      journalTimezone: 'UTC',
      journalDateAssignment: 'default',
    });
    await client.database.insert(contributionRevisions).values({
      id: revisionId,
      contributionId,
      revision: 1,
      text,
      authority: 'manual',
      authorId: ownerId,
      contentHash: hash(text),
    });
    await client.database
      .update(contributions)
      .set({ currentRevisionId: revisionId, currentRevision: 1 })
      .where(eq(contributions.id, contributionId));
  }, 120_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await client?.close();
    await container?.stop();
  });

  it('[SEARCH-002][SEARCH-006][SEC-007][STATE-004] dispatches content-free work and persists complete exact-cohort vectors idempotently', async () => {
    const embeddings = new SearchEmbeddingRepository(client.database);
    await expect(
      embeddings.dispatchPending(boss, () => jobId, 10),
    ).resolves.toEqual([jobId]);
    const queued = await boss.getJobById(queueNames.search, jobId);
    expect(queued?.data).toMatchObject({
      operation: 'search_embedding',
      identifiers: {
        fragmentId: revisionId,
        requestId: revisionId,
        generationKey: '1',
      },
    });
    expect(JSON.stringify(queued?.data)).not.toContain(text);

    const request = await embeddings.load(revisionId);
    expect(request).toMatchObject({
      fragmentId: revisionId,
      status: 'dispatched',
      jobId,
      contentCharacters: [...text].length,
    });
    if (request === undefined) throw new Error('embedding request missing');
    await expect(embeddings.markRunning(revisionId, 1, jobId)).resolves.toBe(
      true,
    );
    const chunk = await embeddings.readChunk(revisionId, 1, 0);
    expect(chunk?.text).toBe(text);
    if (chunk === undefined) throw new Error('embedding chunk missing');
    const cohort = {
      providerId: 'fixture-provider',
      providerDisplayName: 'Fixture provider',
      modelId: 'semantic-fixture',
      modelVersion: '1',
      dimension: 4,
      configuration: { purpose: 'semantic_search' },
      configurationFingerprint: 'a'.repeat(64),
    };
    await expect(
      embeddings.persistChunk({
        request,
        jobId,
        cohort,
        chunk,
        vector: [1, 0, 0, 0],
        createId: () => cohortId,
      }),
    ).resolves.toBe(cohortId);
    await embeddings.markSucceeded(revisionId, 1, jobId);
    await expect(
      new SearchRepository(client.database).semantic({
        ownerId,
        vector: [1, 0, 0, 0],
        cohort: {
          providerId: cohort.providerId,
          modelId: cohort.modelId,
          modelVersion: cohort.modelVersion,
          dimension: cohort.dimension,
          configurationFingerprint: cohort.configurationFingerprint,
        },
        filters: {},
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ sourceRevisionId: revisionId }),
    ]);
    await expect(embeddings.requestOwnerReindex(ownerId)).resolves.toBe(1);
    await expect(
      client.database
        .select({
          status: searchEmbeddingRequests.status,
          generation: searchEmbeddingRequests.generation,
          cohortId: searchEmbeddingRequests.cohortId,
        })
        .from(searchEmbeddingRequests)
        .where(eq(searchEmbeddingRequests.fragmentId, revisionId)),
    ).resolves.toEqual([{ status: 'pending', generation: 2, cohortId: null }]);
  });
});
