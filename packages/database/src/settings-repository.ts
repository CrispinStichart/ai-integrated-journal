import { createHash } from 'node:crypto';

import type {
  RetentionSettings,
  UpdateProviderSettingsRequest,
  UpdateSettingsRequest,
} from '@journal/contracts';
import { createUuidV7 } from '@journal/domain';
import { and, eq, sql } from 'drizzle-orm';

import type { JournalDatabase, JournalTransaction } from './client.js';
import {
  auditEvents,
  providerConfigurations,
  providerCredentials,
  retentionPolicies,
  schedules,
  settingsApiIdempotency,
  users,
} from './schema.js';

export class SettingsNotFoundError extends Error {
  public constructor() {
    super('Owner settings were not found.');
    this.name = 'SettingsNotFoundError';
  }
}

export class SettingsConflictError extends Error {
  public constructor(message = 'Settings changed in another session.') {
    super(message);
    this.name = 'SettingsConflictError';
  }
}

export interface PersistedSettings {
  readonly revision: number;
  readonly journalTimezone: string;
  readonly retention: RetentionSettings;
  readonly backupScheduleEnabled: boolean;
  readonly providers: readonly (typeof providerConfigurations.$inferSelect)[];
  readonly credentialProviderIds: readonly string[];
}

export interface EncryptedProviderCredential {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly encryptionVersion: number;
}

function rawRetention(days: number): RetentionSettings['rawResponseRetention'] {
  if (days === 0) return 'do_not_retain';
  if (days === 30) return 'days_30';
  if (days === 90) return 'days_90';
  if (days === 365) return 'year_1';
  return 'indefinite';
}

function rawRetentionDays(
  value: RetentionSettings['rawResponseRetention'],
): number {
  if (value === 'do_not_retain') return 0;
  if (value === 'days_30') return 30;
  if (value === 'days_90') return 90;
  if (value === 'year_1') return 365;
  return 3_650;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function settingsRequestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

async function ensureRetentionPolicy(
  transaction: JournalTransaction,
  ownerId: string,
) {
  await transaction
    .insert(retentionPolicies)
    .values({ ownerId })
    .onConflictDoNothing();
}

async function replayRevision(input: {
  transaction: JournalTransaction;
  ownerId: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
}): Promise<number | undefined> {
  const [receipt] = await input.transaction
    .select()
    .from(settingsApiIdempotency)
    .where(
      and(
        eq(settingsApiIdempotency.ownerId, input.ownerId),
        eq(settingsApiIdempotency.operation, input.operation),
        eq(settingsApiIdempotency.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (receipt === undefined) return undefined;
  if (receipt.requestHash !== input.requestHash)
    throw new SettingsConflictError(
      'The idempotency key was already used for different settings.',
    );
  return receipt.resultRevision;
}

async function lockOwner(
  transaction: JournalTransaction,
  ownerId: string,
  expectedRevision: number,
) {
  const [owner] = await transaction
    .select()
    .from(users)
    .where(eq(users.id, ownerId))
    .for('update')
    .limit(1);
  if (owner === undefined) throw new SettingsNotFoundError();
  if (owner.preferencesVersion !== expectedRevision)
    throw new SettingsConflictError();
  return owner;
}

export class SettingsRepository {
  public constructor(private readonly database: JournalDatabase) {}

  public async get(ownerId: string): Promise<PersistedSettings> {
    await this.database
      .insert(retentionPolicies)
      .values({ ownerId })
      .onConflictDoNothing();
    const [owner, policy, backup, providers, credentials] = await Promise.all([
      this.database.select().from(users).where(eq(users.id, ownerId)).limit(1),
      this.database
        .select()
        .from(retentionPolicies)
        .where(eq(retentionPolicies.ownerId, ownerId))
        .limit(1),
      this.database
        .select({ enabled: schedules.enabled })
        .from(schedules)
        .where(eq(schedules.key, 'backup.daily'))
        .limit(1),
      this.database
        .select()
        .from(providerConfigurations)
        .where(eq(providerConfigurations.ownerId, ownerId)),
      this.database
        .select({ providerId: providerCredentials.providerId })
        .from(providerCredentials)
        .where(eq(providerCredentials.ownerId, ownerId)),
    ]);
    const ownerRow = owner[0];
    const policyRow = policy[0];
    if (ownerRow === undefined || policyRow === undefined)
      throw new SettingsNotFoundError();
    return {
      revision: ownerRow.preferencesVersion,
      journalTimezone: ownerRow.journalTimeZone,
      retention: {
        materialGraceDays: policyRow.materialGraceDays,
        audioGraceDays: policyRow.audioGraceDays,
        rawResponseRetention: rawRetention(policyRow.rawResponseRetentionDays),
        originalAudioRetention:
          policyRow.originalAudioRetention as RetentionSettings['originalAudioRetention'],
      },
      backupScheduleEnabled: backup[0]?.enabled ?? false,
      providers,
      credentialProviderIds: credentials.map((item) => item.providerId),
    };
  }

  public async update(input: {
    ownerId: string;
    expectedRevision: number;
    request: UpdateSettingsRequest;
    requestHash: string;
    idempotencyKey: string;
    correlationId: string;
    now: Date;
  }): Promise<{ revision: number; replayed: boolean }> {
    return this.database.transaction(async (transaction) => {
      const operation = 'settings.update';
      const replayedRevision = await replayRevision({
        transaction,
        ownerId: input.ownerId,
        operation,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      });
      if (replayedRevision !== undefined)
        return { revision: replayedRevision, replayed: true };
      await lockOwner(transaction, input.ownerId, input.expectedRevision);
      await ensureRetentionPolicy(transaction, input.ownerId);
      const revision = input.expectedRevision + 1;
      await transaction
        .update(users)
        .set({
          journalTimeZone: input.request.journalTimezone,
          preferencesVersion: revision,
          updatedAt: input.now,
        })
        .where(eq(users.id, input.ownerId));
      await transaction
        .update(retentionPolicies)
        .set({
          materialGraceDays: input.request.retention.materialGraceDays,
          audioGraceDays: input.request.retention.audioGraceDays,
          rawResponseRetentionDays: rawRetentionDays(
            input.request.retention.rawResponseRetention,
          ),
          originalAudioRetention:
            input.request.retention.originalAudioRetention,
          updatedAt: input.now,
        })
        .where(eq(retentionPolicies.ownerId, input.ownerId));
      await transaction
        .update(schedules)
        .set({
          enabled: input.request.backupScheduleEnabled,
          updatedAt: input.now,
        })
        .where(eq(schedules.key, 'backup.daily'));
      await transaction.insert(settingsApiIdempotency).values({
        ownerId: input.ownerId,
        operation,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        resultRevision: revision,
        createdAt: input.now,
      });
      await transaction.insert(auditEvents).values({
        id: createUuidV7<'audit-event'>(),
        action: 'settings.preferences_updated',
        actorId: input.ownerId,
        entityType: 'user_settings',
        entityId: input.ownerId,
        correlationId: input.correlationId,
        metadata: {
          revision,
          timezoneChanged: true,
          retentionChanged: true,
          backupScheduleEnabled: input.request.backupScheduleEnabled,
        },
        occurredAt: input.now,
      });
      return { revision, replayed: false };
    });
  }

  public async updateProvider(input: {
    ownerId: string;
    providerId: string;
    expectedRevision: number;
    request: UpdateProviderSettingsRequest;
    requestHash: string;
    idempotencyKey: string;
    disclosureVersion?: string;
    credential?: EncryptedProviderCredential;
    correlationId: string;
    now: Date;
  }): Promise<{ revision: number; replayed: boolean }> {
    return this.database.transaction(async (transaction) => {
      const operation = `settings.provider.${input.providerId}`;
      const replayedRevision = await replayRevision({
        transaction,
        ownerId: input.ownerId,
        operation,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      });
      if (replayedRevision !== undefined)
        return { revision: replayedRevision, replayed: true };
      await lockOwner(transaction, input.ownerId, input.expectedRevision);
      const revision = input.expectedRevision + 1;
      await transaction
        .insert(providerConfigurations)
        .values({
          ownerId: input.ownerId,
          providerId: input.providerId,
          enabled: input.request.enabled,
          models: input.request.models,
          ...(input.disclosureVersion === undefined
            ? {}
            : {
                disclosureVersion: input.disclosureVersion,
                disclosureAcceptedAt: input.now,
              }),
          revision: 1,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [
            providerConfigurations.ownerId,
            providerConfigurations.providerId,
          ],
          set: {
            enabled: input.request.enabled,
            models: input.request.models,
            ...(input.disclosureVersion === undefined
              ? {}
              : {
                  disclosureVersion: input.disclosureVersion,
                  disclosureAcceptedAt: input.now,
                }),
            revision: sql`${providerConfigurations.revision} + 1`,
            updatedAt: input.now,
          },
        });
      if (input.request.clearCredential === true) {
        await transaction
          .delete(providerCredentials)
          .where(
            and(
              eq(providerCredentials.ownerId, input.ownerId),
              eq(providerCredentials.providerId, input.providerId),
            ),
          );
      } else if (input.credential !== undefined) {
        await transaction
          .insert(providerCredentials)
          .values({
            ownerId: input.ownerId,
            providerId: input.providerId,
            ...input.credential,
            updatedAt: input.now,
          })
          .onConflictDoUpdate({
            target: [
              providerCredentials.ownerId,
              providerCredentials.providerId,
            ],
            set: { ...input.credential, updatedAt: input.now },
          });
      }
      await transaction
        .update(users)
        .set({ preferencesVersion: revision, updatedAt: input.now })
        .where(eq(users.id, input.ownerId));
      await transaction.insert(settingsApiIdempotency).values({
        ownerId: input.ownerId,
        operation,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        resultRevision: revision,
        createdAt: input.now,
      });
      await transaction.insert(auditEvents).values({
        id: createUuidV7<'audit-event'>(),
        action: 'settings.provider_updated',
        actorId: input.ownerId,
        entityType: 'provider_configuration',
        correlationId: input.correlationId,
        metadata: {
          providerId: input.providerId,
          enabled: input.request.enabled,
          credentialAction:
            input.request.clearCredential === true
              ? 'cleared'
              : input.credential === undefined
                ? 'unchanged'
                : 'replaced',
          revision,
        },
        occurredAt: input.now,
      });
      return { revision, replayed: false };
    });
  }
}
