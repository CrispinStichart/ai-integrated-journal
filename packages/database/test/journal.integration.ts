import {
  OptimisticConcurrencyError,
  createUuidV7,
  parseIanaTimezone,
  parseJournalDate,
  parseUtcInstant,
  revisionNumber,
} from '@journal/domain';
import { createPostgresTestContainer } from '@journal/test-support';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DeletedContributionError,
  JournalReadRepository,
  JournalWriteRepository,
  createDatabaseClient,
  inTransaction,
  migrateDatabase,
  type DatabaseClient,
} from '../src/index.js';
import { contributionRevisions, users } from '../src/schema.js';

describe('journal domain persistence', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;

  const ownerId = createUuidV7<'user'>({ timestamp: 1_000 });
  const contributionId = createUuidV7<'contribution'>({ timestamp: 2_000 });
  const originalDayId = createUuidV7<'journal-day'>({ timestamp: 3_000 });
  const futureDayId = createUuidV7<'journal-day'>({ timestamp: 4_000 });
  const firstRevisionId = createUuidV7<'contribution-revision'>({
    timestamp: 5_000,
  });
  const capturedAt = parseUtcInstant('2026-08-16T01:30:00Z');
  const originalDate = parseJournalDate('2026-08-15');
  const futureDate = parseJournalDate('2035-12-24');

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
    await client.database.insert(users).values({
      id: ownerId,
      displayName: 'Synthetic owner',
      journalTimeZone: 'America/Los_Angeles',
    });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('[ARCH-001, ARCH-004, ARCH-005, DATA-001, DATA-002, DATA-003, DATA-004, DATA-010, DATA-011, STATE-006, STATE-007] stores source text without a queue or AI dependency', async () => {
    await inTransaction(client.database, async (transaction) => {
      const repository = new JournalWriteRepository(transaction);
      await repository.createTextContribution({
        contributionId,
        revisionId: firstRevisionId,
        proposedJournalDayId: originalDayId,
        ownerId,
        sourceType: 'typed_text',
        text: 'First immutable source.',
        capturedAt,
        capturedTimezone: parseIanaTimezone('Asia/Tokyo'),
        journalTimezone: parseIanaTimezone('America/Los_Angeles'),
        journalDate: originalDate,
        journalDateAssignment: 'default',
        audit: {
          auditId: createUuidV7<'audit-event'>({ timestamp: 6_000 }),
          correlationId: createUuidV7<'correlation'>({ timestamp: 7_000 }),
          occurredAt: capturedAt,
        },
      });
    });

    const stored = await new JournalReadRepository(
      client.database,
    ).getContribution(ownerId, contributionId);
    expect(stored).toMatchObject({
      contribution: {
        id: contributionId,
        journalDayId: originalDayId,
        temporalContext: {
          capturedAt,
          captureTimezone: 'Asia/Tokyo',
          journalTimezone: 'America/Los_Angeles',
          journalDate: originalDate,
        },
      },
      currentRevision: { value: { text: 'First immutable source.' } },
    });
  });

  it('[DATA-012, TIME-001, TIME-002, TIME-003] appends revisions and moves the stable contribution without changing capture context', async () => {
    const secondRevisionId = createUuidV7<'contribution-revision'>({
      timestamp: 8_000,
    });
    await inTransaction(client.database, async (transaction) => {
      const repository = new JournalWriteRepository(transaction);
      await repository.appendTextRevision({
        ownerId,
        contributionId,
        revisionId: secondRevisionId,
        expectedRevision: revisionNumber(1),
        text: 'Second immutable source.',
        editReason: 'Synthetic correction',
        audit: {
          auditId: createUuidV7<'audit-event'>({ timestamp: 9_000 }),
          correlationId: createUuidV7<'correlation'>({ timestamp: 10_000 }),
          occurredAt: parseUtcInstant('2026-08-16T02:00:00Z'),
        },
      });
      await repository.moveContribution({
        ownerId,
        contributionId,
        proposedJournalDayId: futureDayId,
        journalDate: futureDate,
        audit: {
          auditId: createUuidV7<'audit-event'>({ timestamp: 11_000 }),
          correlationId: createUuidV7<'correlation'>({ timestamp: 12_000 }),
          occurredAt: parseUtcInstant('2026-08-16T02:01:00Z'),
        },
      });
    });

    const repository = new JournalReadRepository(client.database);
    const stored = await repository.getContribution(ownerId, contributionId);
    const history = await repository.listContributionRevisions(
      ownerId,
      contributionId,
    );
    expect(stored?.contribution).toMatchObject({
      id: contributionId,
      journalDayId: futureDayId,
      temporalContext: {
        capturedAt,
        captureTimezone: 'Asia/Tokyo',
        journalTimezone: 'America/Los_Angeles',
        journalDate: futureDate,
        journalDateAssignment: 'user_override',
      },
    });
    expect(history.map(({ value }) => value.text)).toEqual([
      'First immutable source.',
      'Second immutable source.',
    ]);
    expect(
      await client.database
        .select({ id: contributionRevisions.id })
        .from(contributionRevisions)
        .where(eq(contributionRevisions.id, firstRevisionId)),
    ).toEqual([{ id: firstRevisionId }]);

    await expect(
      inTransaction(client.database, (transaction) =>
        new JournalWriteRepository(transaction).appendTextRevision({
          ownerId,
          contributionId,
          revisionId: createUuidV7<'contribution-revision'>({
            timestamp: 13_000,
          }),
          expectedRevision: revisionNumber(1),
          text: 'Stale write.',
          audit: {
            auditId: createUuidV7<'audit-event'>({ timestamp: 14_000 }),
            correlationId: createUuidV7<'correlation'>({ timestamp: 15_000 }),
            occurredAt: parseUtcInstant('2026-08-16T02:02:00Z'),
          },
        }),
      ),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyError);
  });

  it('[DATA-011, STATE-006, STATE-007] hides soft-deleted content, restores it, and retains content-free audit history', async () => {
    await inTransaction(client.database, async (transaction) => {
      await new JournalWriteRepository(transaction).softDeleteContribution({
        ownerId,
        contributionId,
        audit: {
          auditId: createUuidV7<'audit-event'>({ timestamp: 16_000 }),
          correlationId: createUuidV7<'correlation'>({ timestamp: 17_000 }),
          occurredAt: parseUtcInstant('2026-08-16T03:00:00Z'),
        },
      });
    });
    const repository = new JournalReadRepository(client.database);
    expect(
      await repository.getContribution(ownerId, contributionId),
    ).toBeUndefined();
    expect(
      await repository.getContribution(ownerId, contributionId, {
        includeDeleted: true,
      }),
    ).toMatchObject({ deletedBy: ownerId });

    await expect(
      inTransaction(client.database, (transaction) =>
        new JournalWriteRepository(transaction).appendTextRevision({
          ownerId,
          contributionId,
          revisionId: createUuidV7<'contribution-revision'>({
            timestamp: 18_000,
          }),
          expectedRevision: revisionNumber(2),
          text: 'Hidden edit.',
          audit: {
            auditId: createUuidV7<'audit-event'>({ timestamp: 19_000 }),
            correlationId: createUuidV7<'correlation'>({ timestamp: 20_000 }),
            occurredAt: parseUtcInstant('2026-08-16T03:01:00Z'),
          },
        }),
      ),
    ).rejects.toBeInstanceOf(DeletedContributionError);

    await inTransaction(client.database, async (transaction) => {
      await new JournalWriteRepository(transaction).restoreContribution({
        ownerId,
        contributionId,
        audit: {
          auditId: createUuidV7<'audit-event'>({ timestamp: 21_000 }),
          correlationId: createUuidV7<'correlation'>({ timestamp: 22_000 }),
          occurredAt: parseUtcInstant('2026-08-16T04:00:00Z'),
        },
      });
    });

    expect(
      await repository.getContribution(ownerId, contributionId),
    ).toMatchObject({
      restoredBy: ownerId,
    });
    expect(
      (
        await repository.listContributionAuditHistory(ownerId, contributionId)
      ).map(({ action }) => action),
    ).toEqual([
      'contribution.restored',
      'contribution.deleted',
      'contribution.moved',
      'contribution.revised',
      'contribution.created',
    ]);
  });
});
