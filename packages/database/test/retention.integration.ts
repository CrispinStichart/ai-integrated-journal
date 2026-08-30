import {
  createUuidV7,
  parseIanaTimezone,
  parseJournalDate,
  parseUtcInstant,
} from '@journal/domain';
import { createPostgresTestContainer } from '@journal/test-support';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DeletedContributionError,
  JournalWriteRepository,
  RetentionRepository,
  contributionRevisions,
  contributions,
  createDatabaseClient,
  deletionTombstones,
  inTransaction,
  journalDays,
  migrateDatabase,
  permanentDeletionRequests,
  recordingChunks,
  recordingUploads,
  recordings,
  searchFragments,
  transcriptRevisions,
  transcripts,
  transcriptionRuns,
  users,
  type DatabaseClient,
} from '../src/index.js';

describe('permanent retention enforcement', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let timestamp = 4_000_000;
  const id = () =>
    createUuidV7<'retention-fixture'>({ timestamp: timestamp++ });
  const ownerId = createUuidV7<'user'>({ timestamp: timestamp++ });
  const otherOwnerId = createUuidV7<'user'>({ timestamp: timestamp++ });
  const contributionId = createUuidV7<'contribution'>({
    timestamp: timestamp++,
  });
  const revisionId = createUuidV7<'contribution-revision'>({
    timestamp: timestamp++,
  });
  const dayId = createUuidV7<'journal-day'>({ timestamp: timestamp++ });
  const deletedAt = parseUtcInstant('2026-07-01T00:00:00.000Z');
  const deletedDate = new Date(deletedAt);
  const purgeAt = new Date('2026-08-25T00:00:00.000Z');
  const audioDayId = createUuidV7<'journal-day'>({ timestamp: timestamp++ });
  const audioContributionId = createUuidV7<'contribution'>({
    timestamp: timestamp++,
  });
  const recordingId = createUuidV7<'recording'>({ timestamp: timestamp++ });
  const uploadId = createUuidV7<'recording-upload'>({ timestamp: timestamp++ });
  const rawResponseId = createUuidV7<'raw-response'>({
    timestamp: timestamp++,
  });
  const transcriptionRunId = createUuidV7<'transcription-run'>({
    timestamp: timestamp++,
  });
  const transcriptId = createUuidV7<'transcript'>({ timestamp: timestamp++ });
  const transcriptRevisionId = createUuidV7<'transcript-revision'>({
    timestamp: timestamp++,
  });

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
    await client.database
      .insert(users)
      .values({ id: ownerId, displayName: 'Retention owner' });
    await inTransaction(client.database, async (transaction) => {
      const repository = new JournalWriteRepository(transaction);
      await repository.createTextContribution({
        contributionId,
        revisionId,
        proposedJournalDayId: dayId,
        ownerId,
        sourceType: 'typed_text',
        text: 'Behavioral fixture that must disappear from every retrieval layer.',
        capturedAt: deletedAt,
        capturedTimezone: parseIanaTimezone('UTC'),
        journalTimezone: parseIanaTimezone('UTC'),
        journalDate: parseJournalDate('2026-07-01'),
        journalDateAssignment: 'default',
        audit: { auditId: id(), correlationId: id(), occurredAt: deletedAt },
      });
      await repository.softDeleteContribution({
        ownerId,
        contributionId,
        audit: { auditId: id(), correlationId: id(), occurredAt: deletedAt },
      });
    });
    await client.database.insert(journalDays).values({
      id: audioDayId,
      userId: ownerId,
      journalDate: '2026-07-02',
    });
    await client.database.insert(contributions).values({
      id: audioContributionId,
      journalDayId: audioDayId,
      authorId: ownerId,
      sourceType: 'recording',
      capturedAt: deletedDate,
      capturedTimezone: 'UTC',
      journalTimezone: 'UTC',
      journalDateAssignment: 'default',
    });
    await client.database.insert(recordings).values({
      id: recordingId,
      contributionId: audioContributionId,
      mimeType: 'audio/webm;codecs=opus',
      finalByteSize: 5n,
      finalSha256: 'a'.repeat(64),
      finalBlobKey: `audio/${recordingId}/original.webm`,
      persistenceState: 'durable',
      audioDeletedAt: deletedDate,
      audioDeletedBy: ownerId,
    });
    await client.database.insert(recordingUploads).values({
      id: uploadId,
      recordingId,
    });
    await client.database.insert(recordingChunks).values({
      uploadId,
      chunkIndex: 0,
      byteSize: 5n,
      sha256: 'b'.repeat(64),
      stagingBlobKey: `staging/${uploadId}/0.chunk`,
    });
    await client.database.insert(transcriptionRuns).values({
      id: transcriptionRunId,
      recordingId,
      attempt: 1,
      status: 'succeeded',
      inputAudioSha256: 'a'.repeat(64),
      inputFingerprint: 'c'.repeat(64),
      rawResponseId,
      rawResponseBlobKey: `provider/${rawResponseId}.json`,
      rawResponseMediaType: 'application/json',
      rawResponseByteSize: 5n,
      rawResponseSha256: 'd'.repeat(64),
      rawResponseProviderRequestId: 'provider-request-sensitive',
      rawResponseRetention: 'days_30',
      rawResponseExpiresAt: deletedDate,
      completedAt: deletedDate,
    });
    await client.database.insert(transcripts).values({
      id: transcriptId,
      recordingId,
      layer: 'raw_stt',
    });
    await client.database.insert(transcriptRevisions).values({
      id: transcriptRevisionId,
      transcriptId,
      sourceRunId: transcriptionRunId,
      revision: 1,
      text: 'Transcript retained independently from original audio.',
      evidenceText: 'Transcript retained independently from original audio.',
      segments: [],
      language: { state: 'unknown' },
      timingAvailability: { segments: 'unknown' },
      authority: 'generated',
      contentHash: 'e'.repeat(64),
      createdAt: deletedDate,
    });
    await client.database
      .update(transcripts)
      .set({
        currentRevisionId: transcriptRevisionId,
        currentRevision: 1,
      })
      .where(eq(transcripts.id, transcriptId));
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('[RET-005][RET-006][RET-007][SEARCH-006] commits a content-free tombstone before cascading source, revision, and index material', async () => {
    expect(
      await client.database
        .select({ id: searchFragments.id })
        .from(searchFragments)
        .where(eq(searchFragments.contributionId, contributionId)),
    ).toHaveLength(0);

    const repository = new RetentionRepository(client.database);
    await expect(
      repository.preview(otherOwnerId, 'contribution', contributionId, purgeAt),
    ).rejects.toMatchObject({ name: 'RetentionNotFoundError' });
    const requested = await repository.request({
      id: id(),
      tombstoneId: id(),
      ownerId,
      entityKind: 'contribution',
      entityId: contributionId,
      correlationId: id(),
      requestedAt: purgeAt,
    });
    expect(requested.replayed).toBe(false);
    const tombstoneBeforePurge = await client.database
      .select()
      .from(deletionTombstones)
      .where(eq(deletionTombstones.entityId, contributionId));
    expect(tombstoneBeforePurge).toHaveLength(1);
    expect(Object.keys(tombstoneBeforePurge[0] ?? {}).sort()).toEqual([
      'correlationId',
      'createdAt',
      'deletedAt',
      'entityId',
      'entityKind',
      'generation',
      'id',
      'ownerId',
    ]);

    expect(
      await repository.claim(purgeAt, requested.deletion.id),
    ).toMatchObject({
      status: 'purging',
      attempts: 1,
    });
    await repository.complete(requested.deletion.id, purgeAt);

    expect(
      await client.database
        .select()
        .from(contributions)
        .where(eq(contributions.id, contributionId)),
    ).toEqual([]);
    expect(
      await client.database
        .select()
        .from(contributionRevisions)
        .where(eq(contributionRevisions.id, revisionId)),
    ).toEqual([]);
    expect(
      await client.database
        .select()
        .from(searchFragments)
        .where(eq(searchFragments.contributionId, contributionId)),
    ).toEqual([]);
    expect(
      await client.database
        .select()
        .from(deletionTombstones)
        .where(eq(deletionTombstones.entityId, contributionId)),
    ).toHaveLength(1);
    expect(
      await client.database
        .select()
        .from(permanentDeletionRequests)
        .where(eq(permanentDeletionRequests.id, requested.deletion.id)),
    ).toMatchObject([
      { status: 'completed', backupCheckpoint: 'not_configured' },
    ]);
  });

  it('[RET-006] rejects restoration and import-like recreation of a tombstoned stable identity', async () => {
    await expect(
      inTransaction(client.database, (transaction) =>
        new JournalWriteRepository(transaction).createTextContribution({
          contributionId,
          revisionId: createUuidV7<'contribution-revision'>({
            timestamp: timestamp++,
          }),
          proposedJournalDayId: createUuidV7<'journal-day'>({
            timestamp: timestamp++,
          }),
          ownerId,
          sourceType: 'typed_text',
          text: 'An old snapshot must not recreate this source.',
          capturedAt: deletedAt,
          capturedTimezone: parseIanaTimezone('UTC'),
          journalTimezone: parseIanaTimezone('UTC'),
          journalDate: parseJournalDate('2026-07-01'),
          journalDateAssignment: 'migration',
          audit: { auditId: id(), correlationId: id(), occurredAt: deletedAt },
        }),
      ),
    ).rejects.toBeInstanceOf(DeletedContributionError);
  });

  it('[RET-002][RET-004][RET-006][RET-007] deletes audio objects and staging rows while preserving the transcript and non-playable recording metadata', async () => {
    const repository = new RetentionRepository(client.database);
    const requested = await repository.request({
      id: id(),
      tombstoneId: id(),
      ownerId,
      entityKind: 'recording_audio',
      entityId: recordingId,
      correlationId: id(),
      requestedAt: purgeAt,
    });
    await expect(repository.blobItems(requested.deletion.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ blobKind: 'final_audio' }),
        expect.objectContaining({ blobKind: 'staging_chunk' }),
      ]),
    );
    await expect(
      repository.claim(purgeAt, requested.deletion.id),
    ).resolves.toMatchObject({ attempts: 1, status: 'purging' });
    await expect(
      repository.claim(
        new Date(purgeAt.getTime() + 16 * 60 * 1_000),
        requested.deletion.id,
      ),
    ).resolves.toMatchObject({ attempts: 2, status: 'purging' });
    for (const item of await repository.blobItems(requested.deletion.id)) {
      await repository.markBlobDeleted(
        requested.deletion.id,
        item.blobKey,
        purgeAt,
      );
    }
    await repository.complete(requested.deletion.id, purgeAt);

    await expect(
      client.database
        .select()
        .from(recordingChunks)
        .where(eq(recordingChunks.uploadId, uploadId)),
    ).resolves.toEqual([]);
    await expect(
      client.database
        .select()
        .from(recordings)
        .where(eq(recordings.id, recordingId)),
    ).resolves.toMatchObject([
      {
        audioDeletedAt: expect.any(Date),
        finalByteSize: 5n,
        finalSha256: 'a'.repeat(64),
        persistenceState: 'durable',
      },
    ]);
    await expect(
      client.database
        .select({ text: transcriptRevisions.text })
        .from(transcriptRevisions)
        .where(eq(transcriptRevisions.id, transcriptRevisionId)),
    ).resolves.toEqual([
      { text: 'Transcript retained independently from original audio.' },
    ]);
  });

  it('[MODEL-006][RET-006][RET-007] erases expired raw provider bytes and sensitive response metadata without deleting provenance runs', async () => {
    const repository = new RetentionRepository(client.database);
    const requested = await repository.request({
      id: id(),
      tombstoneId: id(),
      ownerId,
      entityKind: 'provider_raw_response',
      entityId: rawResponseId,
      correlationId: id(),
      requestedAt: purgeAt,
    });
    const items = await repository.blobItems(requested.deletion.id);
    expect(items).toMatchObject([
      {
        blobKey: `provider/${rawResponseId}.json`,
        blobKind: 'provider_raw_response',
      },
    ]);
    await repository.claim(purgeAt, requested.deletion.id);
    await repository.markBlobDeleted(
      requested.deletion.id,
      items[0]?.blobKey ?? '',
      purgeAt,
    );
    await repository.complete(requested.deletion.id, purgeAt);

    await expect(
      client.database
        .select()
        .from(transcriptionRuns)
        .where(eq(transcriptionRuns.id, transcriptionRunId)),
    ).resolves.toMatchObject([
      {
        id: transcriptionRunId,
        rawResponseId: null,
        rawResponseBlobKey: null,
        rawResponseSha256: null,
        rawResponseProviderRequestId: null,
      },
    ]);
  });

  it('[PORT-001][PORT-002][RET-006] gates configured deletion on a committed tombstone backup checkpoint', async () => {
    const gatedContributionId = createUuidV7<'contribution'>({
      timestamp: timestamp++,
    });
    const gatedRevisionId = createUuidV7<'contribution-revision'>({
      timestamp: timestamp++,
    });
    const gatedDayId = createUuidV7<'journal-day'>({ timestamp: timestamp++ });
    await inTransaction(client.database, async (transaction) => {
      const repository = new JournalWriteRepository(transaction);
      await repository.createTextContribution({
        contributionId: gatedContributionId,
        revisionId: gatedRevisionId,
        proposedJournalDayId: gatedDayId,
        ownerId,
        sourceType: 'typed_text',
        text: 'Synthetic content held until a tombstone checkpoint exists.',
        capturedAt: deletedAt,
        capturedTimezone: parseIanaTimezone('UTC'),
        journalTimezone: parseIanaTimezone('UTC'),
        journalDate: parseJournalDate('2026-07-03'),
        journalDateAssignment: 'migration',
        audit: { auditId: id(), correlationId: id(), occurredAt: deletedAt },
      });
      await repository.softDeleteContribution({
        ownerId,
        contributionId: gatedContributionId,
        audit: { auditId: id(), correlationId: id(), occurredAt: deletedAt },
      });
    });
    const repository = new RetentionRepository(client.database);
    const requested = await repository.request({
      id: id(),
      tombstoneId: id(),
      ownerId,
      entityKind: 'contribution',
      entityId: gatedContributionId,
      correlationId: id(),
      requestedAt: purgeAt,
      backupConfigured: true,
    });
    expect(requested.deletion.backupCheckpoint).toBe('pending');
    await expect(
      repository.claim(purgeAt, requested.deletion.id),
    ).resolves.toBeUndefined();
    await expect(
      client.database
        .select({ id: contributions.id })
        .from(contributions)
        .where(eq(contributions.id, gatedContributionId)),
    ).resolves.toHaveLength(1);

    await client.database
      .update(permanentDeletionRequests)
      .set({ backupCheckpoint: 'committed' })
      .where(eq(permanentDeletionRequests.id, requested.deletion.id));
    await expect(
      repository.claim(purgeAt, requested.deletion.id),
    ).resolves.toMatchObject({ backupCheckpoint: 'committed' });
    await repository.complete(requested.deletion.id, purgeAt);
    await expect(
      client.database
        .select({ id: contributions.id })
        .from(contributions)
        .where(eq(contributions.id, gatedContributionId)),
    ).resolves.toEqual([]);
  });
});
