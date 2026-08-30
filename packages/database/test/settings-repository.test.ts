import { describe, expect, it } from 'vitest';

import {
  SettingsNotFoundError,
  SettingsRepository,
  providerConfigurations,
  providerCredentials,
  retentionPolicies,
  users,
  type JournalDatabase,
} from '../src/index.js';
import { schedules } from '../src/schema.js';

function readDatabase(rowsByTable: ReadonlyMap<object, readonly unknown[]>) {
  return {
    insert: () => ({
      values: () => ({ onConflictDoNothing: async () => undefined }),
    }),
    select: () => {
      let rows: readonly unknown[] = [];
      const builder = {
        from(table: object) {
          rows = rowsByTable.get(table) ?? [];
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return builder;
        },
        then(onFulfilled: (value: readonly unknown[]) => unknown) {
          return Promise.resolve(rows).then(onFulfilled);
        },
      };
      return builder;
    },
  } as unknown as JournalDatabase;
}

describe('settings repository reads', () => {
  it('[TIME-001–TIME-003][RET-001–RET-007][SEC-003] maps durable policy without returning credential material', async () => {
    const ownerId = '019c5b90-0000-7000-8000-000000000071';
    const repository = new SettingsRepository(
      readDatabase(
        new Map<object, readonly unknown[]>([
          [
            users,
            [
              {
                id: ownerId,
                preferencesVersion: 7,
                journalTimeZone: 'America/Chicago',
              },
            ],
          ],
          [
            retentionPolicies,
            [
              {
                ownerId,
                materialGraceDays: 14,
                audioGraceDays: 7,
                rawResponseRetentionDays: 365,
                originalAudioRetention: '90_days',
              },
            ],
          ],
          [schedules, [{ enabled: true }]],
          [
            providerConfigurations,
            [
              {
                ownerId,
                providerId: 'synthetic.external',
                enabled: false,
                models: {},
                disclosureVersion: null,
                disclosureAcceptedAt: null,
                revision: 1,
                updatedAt: new Date('2026-08-30T00:00:00.000Z'),
              },
            ],
          ],
          [providerCredentials, [{ providerId: 'synthetic.external' }]],
        ]),
      ),
    );

    await expect(repository.get(ownerId)).resolves.toMatchObject({
      revision: 7,
      journalTimezone: 'America/Chicago',
      retention: {
        materialGraceDays: 14,
        audioGraceDays: 7,
        rawResponseRetention: 'year_1',
        originalAudioRetention: '90_days',
      },
      backupScheduleEnabled: true,
      credentialProviderIds: ['synthetic.external'],
    });
  });

  it('[SEC-001] fails closed when authenticated owner settings are absent', async () => {
    const repository = new SettingsRepository(
      readDatabase(
        new Map<object, readonly unknown[]>([
          [users, []],
          [retentionPolicies, []],
          [schedules, []],
          [providerConfigurations, []],
          [providerCredentials, []],
        ]),
      ),
    );

    await expect(
      repository.get('019c5b90-0000-7000-8000-000000000071'),
    ).rejects.toBeInstanceOf(SettingsNotFoundError);
  });
});
