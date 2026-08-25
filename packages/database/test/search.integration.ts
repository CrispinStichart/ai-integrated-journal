import { createHash } from 'node:crypto';

import { createUuidV7 } from '@journal/domain';
import { createPostgresTestContainer } from '@journal/test-support';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SearchRepository,
  contributionRevisions,
  contributions,
  createDatabaseClient,
  journalDays,
  memories,
  memoryRevisions,
  migrateDatabase,
  processorArtifactManualRevisions,
  processorArtifacts,
  processorArtifactVersions,
  processorInstallations,
  processorResults,
  processorRuns,
  processorVersions,
  recordings,
  searchEmbeddingCohorts,
  searchEmbeddingRequests,
  searchFragmentEmbeddings,
  transcriptRevisions,
  transcriptionRuns,
  transcripts,
  users,
  type DatabaseClient,
} from '../src/index.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('revision-aware lexical search', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let repository: SearchRepository;
  let timestamp = 1_900_000;
  const id = () => createUuidV7<'search-fixture'>({ timestamp: timestamp++ });
  const ownerId = id();
  const otherOwnerId = id();
  const olderDayId = id();
  const newerDayId = id();
  const now = new Date('2026-08-25T03:00:00.000Z');

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
    repository = new SearchRepository(client.database);
    await client.database
      .insert(users)
      .values({ id: ownerId, displayName: 'Search owner' });
    await client.database.insert(journalDays).values([
      { id: olderDayId, userId: ownerId, journalDate: '2026-08-24' },
      { id: newerDayId, userId: ownerId, journalDate: '2026-08-25' },
    ]);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  async function typed(dayId: string, text: string) {
    const contributionId = id();
    const revisionId = id();
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
      text,
      authority: 'manual',
      authorId: ownerId,
      contentHash: hash(text),
    });
    await client.database
      .update(contributions)
      .set({ currentRevisionId: revisionId, currentRevision: 1 })
      .where(eq(contributions.id, contributionId));
    return { contributionId, revisionId };
  }

  it('[SEARCH-001][SEARCH-003][SEARCH-005] supports phrase/prefix ranking, filters, exact revisions, and stable cursors', async () => {
    const older = await typed(
      olderDayId,
      'A morning blue walk with Nicolette and an alpha reflection.',
    );
    const newer = await typed(
      newerDayId,
      'A morning walk with Nicolette and an alpha reflection.',
    );

    const phrase = await repository.lexical({
      ownerId,
      query: '"morning walk"',
      filters: { layers: ['typed_text'] },
      limit: 10,
    });
    expect(phrase.map(({ sourceRevisionId }) => sourceRevisionId)).toEqual([
      newer.revisionId,
    ]);

    const firstPage = await repository.lexical({
      ownerId,
      query: 'reflec',
      filters: {
        layers: ['typed_text'],
        entity: 'Nicol',
        authority: 'manual',
        dateFrom: '2026-08-24',
        dateTo: '2026-08-25',
        contributionTypes: ['typed_text'],
      },
      limit: 1,
    });
    expect(firstPage).toHaveLength(2);
    expect(firstPage[0]).toMatchObject({
      sourceRevisionId: newer.revisionId,
      journalDate: '2026-08-25',
      layer: 'typed_text',
    });
    const first = firstPage[0];
    if (first === undefined) throw new Error('First search page was empty.');
    const secondPage = await repository.lexical({
      ownerId,
      query: 'reflec',
      filters: { layers: ['typed_text'], entity: 'Nicol' },
      limit: 1,
      cursor: {
        score: first.score,
        journalDate: first.journalDate,
        fragmentId: first.fragmentId,
      },
    });
    expect(secondPage[0]?.sourceRevisionId).toBe(older.revisionId);
  });

  it('[SEARCH-002][SEARCH-005][SEARCH-006][MODEL-003] searches only complete owner-scoped compatible embedding cohorts', async () => {
    const source = await typed(
      newerDayId,
      'A quiet quasarfield visit with an unexpectedly clear sky.',
    );
    const cohortId = id();
    await client.database.insert(searchEmbeddingCohorts).values({
      id: cohortId,
      ownerId,
      providerId: 'fixture-provider',
      providerDisplayName: 'Fixture provider',
      modelId: 'semantic-fixture',
      modelVersion: '1',
      dimension: 4,
      configuration: { purpose: 'semantic_search' },
      configurationFingerprint: hash('semantic-configuration'),
    });
    await client.database
      .update(searchEmbeddingRequests)
      .set({
        status: 'succeeded',
        cohortId,
        completedAt: now,
      })
      .where(eq(searchEmbeddingRequests.fragmentId, source.revisionId));
    await client.database.insert(searchFragmentEmbeddings).values({
      fragmentId: source.revisionId,
      cohortId,
      ownerId,
      chunkIndex: 0,
      startCharacter: 1,
      endCharacter: 59,
      embedding: [1, 0, 0, 0],
    });
    const cohort = {
      providerId: 'fixture-provider',
      modelId: 'semantic-fixture',
      modelVersion: '1',
      dimension: 4,
      configurationFingerprint: hash('semantic-configuration'),
    };
    await expect(repository.hasSearchableCohort(ownerId, cohort)).resolves.toBe(
      true,
    );
    const semantic = await repository.semantic({
      ownerId,
      vector: [0.99, 0.01, 0, 0],
      cohort,
      filters: { layers: ['typed_text'], authority: 'manual' },
      limit: 10,
    });
    expect(semantic).toEqual([
      expect.objectContaining({
        sourceRevisionId: source.revisionId,
        chunkIndex: 0,
        headline: expect.stringContaining('quasarfield'),
      }),
    ]);
    await expect(
      repository.semantic({
        ownerId,
        vector: [1, 0, 0, 0],
        cohort: { ...cohort, modelVersion: '2' },
        filters: {},
        limit: 10,
      }),
    ).resolves.toHaveLength(0);
    await expect(
      repository.semantic({
        ownerId: otherOwnerId,
        vector: [1, 0, 0, 0],
        cohort,
        filters: {},
        limit: 10,
      }),
    ).resolves.toHaveLength(0);
  });

  it('[SEARCH-002][SEARCH-006][RET-007] transactionally requests reindexing and cascades vectors when a revision is replaced or deleted', async () => {
    const source = await typed(newerDayId, 'Lifecycle semantic source');
    await expect(
      client.database
        .select({ status: searchEmbeddingRequests.status })
        .from(searchEmbeddingRequests)
        .where(eq(searchEmbeddingRequests.fragmentId, source.revisionId)),
    ).resolves.toEqual([{ status: 'pending' }]);

    const nextRevisionId = id();
    await client.database.insert(contributionRevisions).values({
      id: nextRevisionId,
      contributionId: source.contributionId,
      revision: 2,
      text: 'Replacement semantic source',
      authority: 'manual',
      authorId: ownerId,
      contentHash: hash('Replacement semantic source'),
    });
    await client.database
      .update(contributions)
      .set({ currentRevisionId: nextRevisionId, currentRevision: 2 })
      .where(eq(contributions.id, source.contributionId));
    expect(
      await client.database
        .select({ fragmentId: searchEmbeddingRequests.fragmentId })
        .from(searchEmbeddingRequests)
        .where(eq(searchEmbeddingRequests.fragmentId, source.revisionId)),
    ).toHaveLength(0);
    expect(
      await client.database
        .select({ status: searchEmbeddingRequests.status })
        .from(searchEmbeddingRequests)
        .where(eq(searchEmbeddingRequests.fragmentId, nextRevisionId)),
    ).toEqual([{ status: 'pending' }]);
    await client.database
      .update(contributions)
      .set({ deletedAt: now, deletedBy: ownerId })
      .where(eq(contributions.id, source.contributionId));
    expect(
      await client.database
        .select({ fragmentId: searchEmbeddingRequests.fragmentId })
        .from(searchEmbeddingRequests)
        .where(eq(searchEmbeddingRequests.fragmentId, nextRevisionId)),
    ).toHaveLength(0);
  });

  it('[SEARCH-001][SEARCH-006][RET-007] immediately excludes old, stale, deleted, and other-owner source material', async () => {
    const source = await typed(newerDayId, 'Old orchard wording');
    const nextRevisionId = id();
    await client.database.insert(contributionRevisions).values({
      id: nextRevisionId,
      contributionId: source.contributionId,
      revision: 2,
      text: 'Fresh orchard wording',
      authority: 'manual',
      authorId: ownerId,
      contentHash: hash('Fresh orchard wording'),
    });
    await client.database
      .update(contributions)
      .set({ currentRevisionId: nextRevisionId, currentRevision: 2 })
      .where(eq(contributions.id, source.contributionId));
    expect(
      await repository.lexical({
        ownerId,
        query: 'old',
        filters: {},
        limit: 10,
      }),
    ).toHaveLength(0);
    expect(
      await repository.lexical({
        ownerId,
        query: 'fresh',
        filters: {},
        limit: 10,
      }),
    ).toHaveLength(1);
    await client.database
      .update(contributions)
      .set({ deletedAt: now, deletedBy: ownerId })
      .where(eq(contributions.id, source.contributionId));
    expect(
      await repository.lexical({
        ownerId,
        query: 'fresh',
        filters: {},
        limit: 10,
      }),
    ).toHaveLength(0);
    await client.database
      .update(contributions)
      .set({ deletedAt: null, deletedBy: null })
      .where(eq(contributions.id, source.contributionId));
    expect(
      await repository.lexical({
        ownerId: otherOwnerId,
        query: 'fresh',
        filters: {},
        limit: 10,
      }),
    ).toHaveLength(0);
  });

  it('[SEARCH-001][SEARCH-005][SEARCH-006] indexes only the selected current non-stale transcript layer', async () => {
    const contributionId = id();
    const recordingId = id();
    const runId = id();
    const transcriptId = id();
    const revisionId = id();
    await client.database.insert(contributions).values({
      id: contributionId,
      journalDayId: newerDayId,
      authorId: ownerId,
      sourceType: 'recording',
      capturedAt: now,
      capturedTimezone: 'UTC',
      journalTimezone: 'UTC',
      journalDateAssignment: 'default',
    });
    await client.database.insert(recordings).values({
      id: recordingId,
      contributionId,
      mimeType: 'audio/webm',
    });
    await client.database.insert(transcriptionRuns).values({
      id: runId,
      recordingId,
      attempt: 1,
      status: 'succeeded',
      inputAudioSha256: hash('audio'),
      inputFingerprint: hash('input'),
      completedAt: now,
    });
    await client.database.insert(transcripts).values({
      id: transcriptId,
      recordingId,
      layer: 'raw_stt',
    });
    await client.database.insert(transcriptRevisions).values({
      id: revisionId,
      transcriptId,
      sourceRunId: runId,
      revision: 1,
      text: 'Spoken firefly detail',
      evidenceText: 'Spoken firefly detail',
      segments: [],
      language: { status: 'unknown' },
      timingAvailability: { segments: 'unknown' },
      authority: 'generated',
      contentHash: hash('Spoken firefly detail'),
    });
    await client.database
      .update(transcripts)
      .set({ currentRevisionId: revisionId, currentRevision: 1 })
      .where(eq(transcripts.id, transcriptId));
    expect(
      await repository.lexical({
        ownerId,
        query: 'fire',
        filters: { layers: ['raw_stt'] },
        limit: 10,
      }),
    ).toEqual([
      expect.objectContaining({
        transcriptId,
        sourceRevisionId: revisionId,
        layer: 'raw_stt',
      }),
    ]);
    await client.database
      .update(transcriptRevisions)
      .set({ staleAt: now, staleReason: 'corrected_source_changed' })
      .where(eq(transcriptRevisions.id, revisionId));
    expect(
      await repository.lexical({
        ownerId,
        query: 'fire',
        filters: {},
        limit: 10,
      }),
    ).toHaveLength(0);
  });

  it('[SEARCH-001][SEARCH-005][SEARCH-006] indexes only approved current memories and effective non-stale artifact authority', async () => {
    const memoryId = id();
    const memoryRevisionId = id();
    await client.database.insert(memories).values({
      id: memoryId,
      ownerId,
      currentRevisionId: memoryRevisionId,
      currentRevision: 1,
      approvalState: 'approved',
      enabled: true,
    });
    await client.database.insert(memoryRevisions).values({
      id: memoryRevisionId,
      memoryId,
      revision: 1,
      type: 'known_fact',
      content: 'Nicolette prefers the observatory.',
      rationale: 'Synthetic approved fact.',
      creator: 'user',
      approvalState: 'approved',
      scope: { kind: 'global_known_fact' },
      enabled: true,
    });
    expect(
      await repository.lexical({
        ownerId,
        query: 'observ',
        filters: { layers: ['memory'], authority: 'manual' },
        limit: 10,
      }),
    ).toEqual([
      expect.objectContaining({
        sourceRevisionId: memoryRevisionId,
        memoryId,
        journalDate: null,
      }),
    ]);
    await client.database
      .update(memories)
      .set({ enabled: false })
      .where(eq(memories.id, memoryId));
    expect(
      await repository.lexical({
        ownerId,
        query: 'observ',
        filters: {},
        limit: 10,
      }),
    ).toHaveLength(0);

    const processorId = id();
    const processorVersionId = id();
    const runId = id();
    const resultId = id();
    const artifactId = id();
    const artifactVersionId = id();
    await client.database.insert(processorInstallations).values({
      id: processorId,
      key: `summary-${processorId}`,
      displayName: 'Synthetic search summary',
      purpose: 'Exercise artifact search indexing.',
      currentVersionId: processorVersionId,
    });
    await client.database.insert(processorVersions).values({
      id: processorVersionId,
      processorId,
      revision: 1,
      semanticVersion: '1.0.0',
      definition: {},
      instructionHash: hash('instruction'),
      outputSchemaHash: hash('schema'),
      promptTemplateHash: hash('prompt'),
    });
    await client.database.insert(processorRuns).values({
      id: runId,
      processorId,
      processorVersionId,
      targetScope: 'journal_day',
      targetJournalDayId: newerDayId,
      attempt: 1,
      status: 'succeeded',
      inputCompleteness: 'complete',
      inputFingerprint: hash('artifact-input'),
      promptAssemblyVersion: 'v1',
      promptTemplateHash: hash('prompt'),
      outputResultId: resultId,
      completedAt: now,
    });
    await client.database.insert(processorResults).values({
      id: resultId,
      runId,
      processorId,
      processorVersionId,
      targetJournalDayId: newerDayId,
      kind: 'interpretation',
      completeness: 'complete',
      payload: { narrative: 'Generated comet summary.' },
    });
    await client.database.insert(processorArtifacts).values({
      id: artifactId,
      processorId,
      targetJournalDayId: newerDayId,
      logicalKey: 'daily-summary',
      kind: 'interpretation',
      revision: 1,
    });
    await client.database.insert(processorArtifactVersions).values({
      id: artifactVersionId,
      artifactId,
      runId,
      sourceResultId: resultId,
      processorVersionId,
      revision: 1,
      payload: { narrative: 'Generated comet summary.' },
      payloadHash: hash(
        JSON.stringify({ narrative: 'Generated comet summary.' }),
      ),
      reconciliationOutcome: 'create',
    });
    expect(
      await repository.lexical({
        ownerId,
        query: 'comet',
        filters: {
          processorId,
          resultType: 'interpretation',
          authority: 'generated',
        },
        limit: 10,
      }),
    ).toEqual([
      expect.objectContaining({
        sourceRevisionId: artifactVersionId,
        processorVersionId,
        artifactId,
      }),
    ]);

    const manualRevisionId = id();
    await client.database.insert(processorArtifactManualRevisions).values({
      id: manualRevisionId,
      artifactId,
      revision: 1,
      operation: 'correct',
      payload: { narrative: 'Manual comet correction.' },
      payloadHash: hash(
        JSON.stringify({ narrative: 'Manual comet correction.' }),
      ),
      authorId: ownerId,
      editGroupId: id(),
    });
    const effective = await repository.lexical({
      ownerId,
      query: 'comet',
      filters: { authority: 'manual' },
      limit: 10,
    });
    expect(effective).toEqual([
      expect.objectContaining({
        sourceKind: 'artifact_manual_revision',
        sourceRevisionId: manualRevisionId,
      }),
    ]);
    await client.database
      .update(processorArtifactManualRevisions)
      .set({ staleAt: now, staleReason: 'source_changed' })
      .where(eq(processorArtifactManualRevisions.id, manualRevisionId));
    await client.database
      .update(processorResults)
      .set({ staleAt: now, staleReason: 'source_changed' })
      .where(eq(processorResults.id, resultId));
    expect(
      await repository.lexical({
        ownerId,
        query: 'comet',
        filters: {},
        limit: 10,
      }),
    ).toHaveLength(0);
  });
});
