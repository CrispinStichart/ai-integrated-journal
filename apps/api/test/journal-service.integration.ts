import {
  createDatabaseClient,
  migrateDatabase,
  users,
  type DatabaseClient,
} from '@journal/database';
import { createUuidV7 } from '@journal/domain';
import { createPostgresTestContainer } from '@journal/test-support';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresJournalService } from '../src/journal-service.js';

describe('Journal REST persistence integration', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;

  const ownerId = createUuidV7<'user'>({ timestamp: 30_000 });
  const contributionId = createUuidV7<'contribution'>({ timestamp: 31_000 });
  const firstDayId = createUuidV7<'journal-day'>({ timestamp: 32_000 });
  const secondDayId = createUuidV7<'journal-day'>({ timestamp: 33_000 });
  const firstRevisionId = createUuidV7<'contribution-revision'>({
    timestamp: 34_000,
  });
  const correlationId = createUuidV7<'correlation'>({ timestamp: 35_000 });

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
    await client.database.insert(users).values({
      id: ownerId,
      displayName: 'API integration owner',
      journalTimeZone: 'America/New_York',
    });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('[DATA-001–DATA-013, DATA-026, TIME-001–TIME-003, STATE-006–STATE-007] persists the complete REST lifecycle and durable retries', async () => {
    const instants = [
      '2026-08-16T12:00:00.000Z',
      '2026-08-16T12:01:00.000Z',
      '2026-08-16T12:02:00.000Z',
      '2026-08-16T12:03:00.000Z',
      '2026-08-16T12:04:00.000Z',
    ];
    let index = 0;
    const service = new PostgresJournalService(
      client.database,
      () => new Date(instants.at(index++) ?? '2026-08-16T12:04:00.000Z'),
    );
    const createInput = {
      contributionId,
      revisionId: firstRevisionId,
      proposedJournalDayId: firstDayId,
      sourceType: 'typed_text' as const,
      text: 'First source revision.',
      capturedAt: '2026-08-16T12:00:00.000Z',
      capturedTimezone: 'America/New_York',
      journalTimezone: 'America/New_York',
      journalDate: '2026-08-16',
      journalDateAssignment: 'default' as const,
    };

    const created = await service.create(
      ownerId,
      createInput,
      'integration-create',
      correlationId,
    );
    const replay = await service.create(
      ownerId,
      createInput,
      'integration-create',
      correlationId,
    );
    expect(created.replayed).toBe(false);
    expect(replay.replayed).toBe(true);

    const calendar = await service.listDays(ownerId, { limit: 1 });
    expect(calendar.items).toEqual([
      expect.objectContaining({
        id: firstDayId,
        contributionCount: 1,
        journalDate: '2026-08-16',
      }),
    ]);
    expect(
      (await service.getDay(ownerId, '2026-08-16', false))?.contributions,
    ).toHaveLength(1);

    const edited = await service.edit(
      ownerId,
      contributionId,
      {
        revisionId: createUuidV7<'contribution-revision'>({
          timestamp: 36_000,
        }),
        text: 'Second source revision.',
        editReason: 'Correction',
      },
      1,
      'integration-edit',
      correlationId,
    );
    expect(edited.contribution.currentRevision?.revision).toBe(2);
    expect(
      (await service.listRevisions(ownerId, contributionId, { limit: 1 }))
        .hasMore,
    ).toBe(true);

    await service.move(
      ownerId,
      contributionId,
      { proposedJournalDayId: secondDayId, journalDate: '2030-01-01' },
      2,
      'integration-move',
      correlationId,
    );
    expect(
      (await service.getContribution(ownerId, contributionId))?.journalDate,
    ).toBe('2030-01-01');

    await service.delete(
      ownerId,
      contributionId,
      2,
      'integration-delete',
      correlationId,
    );
    expect(
      await service.getContribution(ownerId, contributionId),
    ).toBeUndefined();
    expect(
      await service.getContribution(ownerId, contributionId, true),
    ).toMatchObject({ deletedAt: expect.any(String) });

    await service.restore(
      ownerId,
      contributionId,
      2,
      'integration-restore',
      correlationId,
    );
    expect(
      await service.getContribution(ownerId, contributionId),
    ).toMatchObject({
      restoredAt: expect.any(String),
    });
  });
});
