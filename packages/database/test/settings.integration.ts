import { createUuidV7 } from '@journal/domain';
import { createPostgresTestContainer } from '@journal/test-support';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SettingsConflictError,
  SettingsRepository,
  auditEvents,
  createDatabaseClient,
  migrateDatabase,
  providerCredentials,
  seedDatabase,
  settingsRequestHash,
  users,
  type DatabaseClient,
} from '../src/index.js';

describe('settings persistence', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let repository: SettingsRepository;
  let timestamp = 9_000_000;
  const id = () => createUuidV7<'settings-fixture'>({ timestamp: timestamp++ });
  const ownerId = id();

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
    await seedDatabase(client.database, 'test');
    await client.database.insert(users).values({
      id: ownerId,
      displayName: 'Settings owner',
      journalTimeZone: 'UTC',
    });
    repository = new SettingsRepository(client.database);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('[TIME-001–TIME-003][RET-001–RET-007][PORT-001–PORT-002][SEC-008] atomically versions timezone, retention, backup, and audit metadata', async () => {
    const request = {
      journalTimezone: 'America/Chicago',
      retention: {
        materialGraceDays: 14,
        audioGraceDays: 7,
        rawResponseRetention: 'days_90' as const,
        originalAudioRetention: '365_days' as const,
      },
      backupScheduleEnabled: true,
    };
    const first = await repository.update({
      ownerId,
      expectedRevision: 1,
      request,
      requestHash: settingsRequestHash(request),
      idempotencyKey: 'settings-retry-key',
      correlationId: id(),
      now: new Date('2026-08-30T04:00:00.000Z'),
    });
    const replay = await repository.update({
      ownerId,
      expectedRevision: 1,
      request,
      requestHash: settingsRequestHash(request),
      idempotencyKey: 'settings-retry-key',
      correlationId: id(),
      now: new Date('2026-08-30T04:01:00.000Z'),
    });
    const settings = await repository.get(ownerId);

    expect(first).toEqual({ revision: 2, replayed: false });
    expect(replay).toEqual({ revision: 2, replayed: true });
    expect(settings).toMatchObject({
      revision: 2,
      journalTimezone: 'America/Chicago',
      retention: request.retention,
      backupScheduleEnabled: true,
    });
    const audit = await client.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'settings.preferences_updated'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('America/Chicago');
  });

  it('[SEC-003–SEC-006][MODEL-001–MODEL-006] persists only encrypted credential material and rejects stale writes', async () => {
    const request = {
      enabled: true,
      models: { speech_to_text: 'speech-v2' },
      acknowledgeDisclosureVersion: 'a'.repeat(64),
      credential: 'never-store-this-plaintext',
    };
    await repository.updateProvider({
      ownerId,
      providerId: 'synthetic.external',
      expectedRevision: 2,
      request,
      requestHash: settingsRequestHash({ ...request, credential: 'hmac' }),
      idempotencyKey: 'provider-settings-key',
      disclosureVersion: 'a'.repeat(64),
      credential: {
        ciphertext: 'encrypted-value',
        nonce: 'unique-nonce',
        encryptionVersion: 1,
      },
      correlationId: id(),
      now: new Date('2026-08-30T05:00:00.000Z'),
    });
    const [credential] = await client.database
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.ownerId, ownerId));
    const settings = await repository.get(ownerId);

    expect(credential).toMatchObject({
      providerId: 'synthetic.external',
      ciphertext: 'encrypted-value',
    });
    expect(JSON.stringify(credential)).not.toContain(request.credential);
    expect(settings.credentialProviderIds).toEqual(['synthetic.external']);
    await expect(
      repository.updateProvider({
        ownerId,
        providerId: 'synthetic.external',
        expectedRevision: 2,
        request: { enabled: false, models: {} },
        requestHash: settingsRequestHash({ enabled: false, models: {} }),
        idempotencyKey: 'provider-stale-key',
        correlationId: id(),
        now: new Date('2026-08-30T05:01:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(SettingsConflictError);
  });
});
