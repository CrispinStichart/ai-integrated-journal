import { createUuidV7, parseUtcInstant, parseUuidV7 } from '@journal/domain';
import { createPostgresTestContainer } from '@journal/test-support';
import { and, eq, inArray } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ExportRepository,
  JournalWriteRepository,
  RetentionRepository,
  auditEvents,
  contributionRevisions,
  contributions,
  createDatabaseClient,
  exportBlobLeases,
  exportRequests,
  exportSnapshotItems,
  groundedAnswers,
  journalDays,
  inTransaction,
  migrateDatabase,
  provisionQueueFoundation,
  queueNames,
  recordings,
  seedDatabase,
  users,
  type DatabaseClient,
} from '../src/index.js';

describe('point-in-time export snapshot persistence', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let boss: PgBoss;
  let timestamp = 5_000_000;
  const id = () => createUuidV7<'export-fixture'>({ timestamp: timestamp++ });
  const ownerId = id();
  const dayId = id();
  const contributionId = id();
  const revisionId = id();
  const recordingId = id();
  const answerId = id();
  const rawResponseId = id();
  const exportId = id();
  const rawExcludedExportId = id();
  const expiredExportId = id();
  const failedExportId = id();
  const claimExpiredExportId = id();
  const rollbackExportId = id();
  const snapshotAt = new Date('2026-08-25T00:00:00.000Z');

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
    await seedDatabase(client.database, 'test');
    boss = new PgBoss({
      application_name: '@journal/export-test',
      connectionString: container.getConnectionUri(),
      migrate: true,
      schedule: false,
      supervise: false,
      useListenNotify: true,
    });
    await provisionQueueFoundation(boss, client);
    await client.database.insert(users).values({
      id: ownerId,
      displayName: 'Export owner',
    });
    await client.database
      .insert(journalDays)
      .values({ id: dayId, userId: ownerId, journalDate: '2026-08-24' });
    await client.database.insert(contributions).values({
      id: contributionId,
      journalDayId: dayId,
      authorId: ownerId,
      sourceType: 'recording',
      capturedAt: new Date('2026-08-24T20:00:00.000Z'),
      capturedTimezone: 'America/New_York',
      journalTimezone: 'America/New_York',
      journalDateAssignment: 'user_override',
    });
    await client.database.insert(contributionRevisions).values({
      id: revisionId,
      contributionId,
      revision: 1,
      text: 'Manual text with explicit semantic state.',
      authority: 'manual',
      authorId: ownerId,
      contentHash: 'a'.repeat(64),
    });
    await client.database
      .update(contributions)
      .set({ currentRevisionId: revisionId, currentRevision: 1 })
      .where(eq(contributions.id, contributionId));
    await client.database.insert(recordings).values({
      id: recordingId,
      contributionId,
      mimeType: 'audio/webm',
      persistenceState: 'durable',
      finalBlobKey: `audio/${recordingId}/original.webm`,
      finalByteSize: 12n,
      finalSha256: 'b'.repeat(64),
    });
    await client.database.insert(groundedAnswers).values({
      id: answerId,
      ownerId,
      question: 'Synthetic portability fixture?',
      request: {},
      requestHash: 'c'.repeat(64),
      idempotencyKey: 'export-raw-answer-fixture',
      retrieval: {},
      promptId: 'grounded-answer',
      promptVersion: '1',
      promptTemplateHash: 'd'.repeat(64),
      requestedConfiguration: {},
      rawResponseId,
      rawResponseBlobKey: `provider-raw/${rawResponseId}`,
      rawResponseMediaType: 'application/json',
      rawResponseByteSize: 9_007_199_254_740_993n,
      rawResponseSha256: 'e'.repeat(64),
      rawResponseRetention: '30_days',
      rawResponseExpiresAt: new Date('2026-08-24T00:00:00.000Z'),
    });
  }, 120_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await client?.close();
    await container?.stop();
  });

  it('[PORT-003][PORT-004][PORT-005][PORT-007][MODEL-006][STATE-004][AC-050] freezes an atomic point-in-time snapshot while a later edit creates a new revision', async () => {
    const repository = new ExportRepository(client.database);
    const created = await repository.createSnapshot({
      id: exportId,
      ownerId,
      includeAudio: true,
      includeProviderRawResponses: true,
      now: () => snapshotAt,
      correlationId: id(),
      boss,
      idempotencyKey: 'export-snapshot-fixture',
    });
    expect(created.row.snapshotAt).toEqual(snapshotAt);
    expect(created.replayed).toBe(false);
    expect(await boss.getJobById(queueNames.export, exportId)).toMatchObject({
      id: exportId,
      data: expect.objectContaining({
        operation: 'export',
        identifiers: expect.objectContaining({ exportId }),
      }),
    });
    const replay = await repository.createSnapshot({
      id: id(),
      ownerId,
      includeAudio: true,
      includeProviderRawResponses: true,
      now: () => new Date('2026-08-25T00:05:00.000Z'),
      correlationId: id(),
      boss,
      idempotencyKey: 'export-snapshot-fixture',
    });
    expect(replay).toMatchObject({ replayed: true, row: { id: exportId } });
    await expect(
      repository.createSnapshot({
        id: id(),
        ownerId,
        includeAudio: false,
        includeProviderRawResponses: false,
        now: () => new Date('2026-08-25T00:05:00.000Z'),
        correlationId: id(),
        boss,
        idempotencyKey: 'export-snapshot-fixture',
      }),
    ).rejects.toMatchObject({ name: 'ExportConflictError' });
    const revisionItems = await client.database
      .select()
      .from(exportSnapshotItems)
      .where(
        and(
          eq(exportSnapshotItems.exportId, exportId),
          eq(exportSnapshotItems.entityType, 'contribution_revision'),
        ),
      );
    expect(revisionItems).toHaveLength(1);
    expect(revisionItems[0]).toMatchObject({
      stableId: contributionId,
      versionId: revisionId,
      journalDate: '2026-08-24',
      payload: expect.objectContaining({
        authority: 'manual',
        text: 'Manual text with explicit semantic state.',
      }),
    });
    expect(
      await client.database
        .select()
        .from(exportBlobLeases)
        .where(eq(exportBlobLeases.exportId, exportId)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: recordingId,
          blobKind: 'audio',
          sha256: 'b'.repeat(64),
          byteSize: 12n,
        }),
        expect.objectContaining({
          entityId: rawResponseId,
          blobKind: 'provider_raw_response',
          sha256: 'e'.repeat(64),
          byteSize: 9_007_199_254_740_993n,
        }),
      ]),
    );

    await client.database.insert(contributionRevisions).values({
      id: id(),
      contributionId,
      revision: 2,
      text: 'Committed after snapshot.',
      authority: 'manual',
      authorId: ownerId,
      contentHash: 'c'.repeat(64),
    });
    expect(
      await client.database
        .select()
        .from(exportSnapshotItems)
        .where(
          and(
            eq(exportSnapshotItems.exportId, exportId),
            eq(exportSnapshotItems.entityType, 'contribution_revision'),
          ),
        ),
    ).toHaveLength(1);

    const downloadCorrelationId = id();
    await repository.recordDownload({
      ownerId,
      exportId,
      correlationId: downloadCorrelationId,
      occurredAt: snapshotAt,
    });
    expect(
      await client.database
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.correlationId, downloadCorrelationId)),
    ).toEqual([{ action: 'export.download_started' }]);
  });

  it('[STATE-004] rolls back the snapshot and leases when transactional queue insertion fails', async () => {
    await expect(
      new ExportRepository(client.database).createSnapshot({
        id: rollbackExportId,
        ownerId,
        includeAudio: true,
        includeProviderRawResponses: false,
        now: () => snapshotAt,
        correlationId: id(),
        boss: { send: async () => null } as unknown as PgBoss,
        idempotencyKey: 'export-rollback-fixture',
      }),
    ).rejects.toThrow('Queue rejected the transactional job');
    expect(
      await client.database
        .select()
        .from(exportRequests)
        .where(eq(exportRequests.id, rollbackExportId)),
    ).toEqual([]);
    expect(
      await client.database
        .select()
        .from(exportSnapshotItems)
        .where(eq(exportSnapshotItems.exportId, rollbackExportId)),
    ).toEqual([]);
  });

  it('[RET-007][MODEL-006] excludes a tombstoned provider payload from every new export snapshot', async () => {
    await new RetentionRepository(client.database).request({
      id: id(),
      tombstoneId: id(),
      ownerId,
      entityKind: 'provider_raw_response',
      entityId: rawResponseId,
      correlationId: id(),
      requestedAt: snapshotAt,
    });
    await new ExportRepository(client.database).createSnapshot({
      id: rawExcludedExportId,
      ownerId,
      includeAudio: false,
      includeProviderRawResponses: true,
      now: () => snapshotAt,
      correlationId: id(),
      boss,
      idempotencyKey: 'export-after-raw-tombstone-fixture',
    });

    expect(
      await client.database
        .select()
        .from(exportBlobLeases)
        .where(eq(exportBlobLeases.exportId, rawExcludedExportId)),
    ).toEqual([]);
  });

  it('[RET-007] closes expired downloads and releases leases before hosted blob cleanup', async () => {
    await client.database.insert(exportRequests).values({
      id: expiredExportId,
      ownerId,
      idempotencyKey: 'export-expiry-fixture',
      status: 'completed',
      snapshotAt,
      expiresAt: new Date('2026-08-24T00:00:00.000Z'),
      archiveBlobKey: `exports/${expiredExportId}.zip`,
      archiveByteSize: 12n,
      archiveSha256: 'd'.repeat(64),
    });
    await client.database.insert(exportBlobLeases).values({
      exportId: expiredExportId,
      entityId: recordingId,
      blobKind: 'audio',
      blobKey: `audio/${recordingId}/original.webm`,
      archivePath: `audio/${recordingId}/original`,
      mediaType: 'audio/webm',
      byteSize: 12n,
      sha256: 'b'.repeat(64),
      leaseExpiresAt: new Date('2026-08-24T00:00:00.000Z'),
    });
    const repository = new ExportRepository(client.database);
    expect(await repository.expireDue(snapshotAt)).toContainEqual({
      id: expiredExportId,
      archiveBlobKey: `exports/${expiredExportId}.zip`,
    });
    await repository.markHostedArchiveDeleted(
      expiredExportId,
      `exports/${expiredExportId}.zip`,
      new Date('2026-08-25T00:00:01.000Z'),
    );
    expect(
      await client.database
        .select({
          status: exportRequests.status,
          archiveBlobKey: exportRequests.archiveBlobKey,
        })
        .from(exportRequests)
        .where(eq(exportRequests.id, expiredExportId)),
    ).toEqual([{ status: 'expired', archiveBlobKey: null }]);
    expect(
      await client.database
        .select({ releasedAt: exportBlobLeases.releasedAt })
        .from(exportBlobLeases)
        .where(eq(exportBlobLeases.exportId, expiredExportId)),
    ).toEqual([{ releasedAt: snapshotAt }]);
  });

  it('[PORT-004][RET-007] releases immutable source leases when generation fails or an already-expired job is claimed', async () => {
    await client.database.insert(exportRequests).values([
      {
        id: failedExportId,
        ownerId,
        idempotencyKey: 'export-failed-fixture',
        status: 'running',
        snapshotAt,
        expiresAt: new Date('2026-08-26T00:00:00.000Z'),
      },
      {
        id: claimExpiredExportId,
        ownerId,
        idempotencyKey: 'export-claim-expired-fixture',
        status: 'queued',
        snapshotAt,
        expiresAt: new Date('2026-08-24T00:00:00.000Z'),
      },
    ]);
    await client.database.insert(exportBlobLeases).values([
      {
        exportId: failedExportId,
        entityId: recordingId,
        blobKind: 'audio',
        blobKey: `audio/${recordingId}/failed.webm`,
        archivePath: `audio/${recordingId}/failed`,
        mediaType: 'audio/webm',
        byteSize: 12n,
        sha256: 'b'.repeat(64),
        leaseExpiresAt: new Date('2026-08-26T00:00:00.000Z'),
      },
      {
        exportId: claimExpiredExportId,
        entityId: recordingId,
        blobKind: 'audio',
        blobKey: `audio/${recordingId}/claim-expired.webm`,
        archivePath: `audio/${recordingId}/claim-expired`,
        mediaType: 'audio/webm',
        byteSize: 12n,
        sha256: 'b'.repeat(64),
        leaseExpiresAt: new Date('2026-08-24T00:00:00.000Z'),
      },
    ]);
    const repository = new ExportRepository(client.database);
    await repository.fail(failedExportId, 'fixture_failure', snapshotAt);
    await expect(repository.claim(claimExpiredExportId, snapshotAt)).resolves
      .toBeUndefined;
    expect(
      await client.database
        .select({
          exportId: exportBlobLeases.exportId,
          releasedAt: exportBlobLeases.releasedAt,
        })
        .from(exportBlobLeases)
        .where(
          inArray(exportBlobLeases.exportId, [
            failedExportId,
            claimExpiredExportId,
          ]),
        ),
    ).toEqual(
      expect.arrayContaining([
        { exportId: failedExportId, releasedAt: snapshotAt },
        { exportId: claimExpiredExportId, releasedAt: snapshotAt },
      ]),
    );
  });

  it('[RET-006][RET-007] makes concurrent soft or permanent deletion invalidate queued and completed export delivery', async () => {
    const deletedAt = new Date('2026-07-01T00:00:00.000Z');
    await client.database
      .update(exportRequests)
      .set({
        status: 'completed',
        archiveBlobKey: `exports/${exportId}.zip`,
        archiveByteSize: 12n,
        archiveSha256: 'e'.repeat(64),
      })
      .where(eq(exportRequests.id, exportId));
    await inTransaction(client.database, async (transaction) => {
      await new JournalWriteRepository(transaction).softDeleteContribution({
        ownerId: parseUuidV7<'user'>(ownerId),
        contributionId: parseUuidV7<'contribution'>(contributionId),
        audit: {
          auditId: id(),
          correlationId: id(),
          occurredAt: parseUtcInstant(deletedAt.toISOString()),
        },
      });
    });
    expect(
      await client.database
        .select({
          status: exportRequests.status,
          errorCode: exportRequests.errorCode,
        })
        .from(exportRequests)
        .where(eq(exportRequests.id, exportId)),
    ).toEqual([{ status: 'invalidated', errorCode: 'source_soft_deleted' }]);
    expect(
      await new ExportRepository(client.database).expireDue(snapshotAt),
    ).toContainEqual({
      id: exportId,
      archiveBlobKey: `exports/${exportId}.zip`,
    });
    const retention = new RetentionRepository(client.database);
    await retention.request({
      id: id(),
      tombstoneId: id(),
      ownerId,
      entityKind: 'contribution',
      entityId: contributionId,
      correlationId: id(),
      requestedAt: snapshotAt,
    });
    expect(
      await client.database
        .select({ status: exportRequests.status })
        .from(exportRequests)
        .where(eq(exportRequests.id, exportId)),
    ).toEqual([{ status: 'invalidated' }]);
  });
});
