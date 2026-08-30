import type { AiProviderDescriptor } from '@journal/ai';
import type { UpdateProviderSettingsRequest } from '@journal/contracts';
import type {
  JournalDatabase,
  PersistedSettings,
  SettingsRepository,
} from '@journal/database';
import { describe, expect, it, vi } from 'vitest';

import {
  PostgresSettingsService,
  SettingsValidationError,
  createProviderCredentialCipher,
  providerDisclosureVersion,
} from '../src/settings-service.js';

const OWNER_ID = '019c5b90-0000-7000-8000-000000000071';
const NOW = new Date('2026-08-30T06:00:00.000Z');
const KEY = Buffer.alloc(32, 7).toString('base64url');
const descriptor: AiProviderDescriptor = {
  id: 'synthetic.external',
  displayName: 'Synthetic external provider',
  capabilities: ['speech_to_text', 'structured_generation'],
  disclosure: {
    contentRecipient: 'Synthetic Corp',
    external: true,
    retention: { status: 'known', value: '30 days' },
    trainingUse: { status: 'unknown' },
    privacyPolicyUrl: 'https://provider.example/privacy',
  },
};

function persisted(
  overrides: Partial<PersistedSettings> = {},
): PersistedSettings {
  return {
    revision: 2,
    journalTimezone: 'UTC',
    retention: {
      materialGraceDays: 30,
      audioGraceDays: 30,
      rawResponseRetention: 'days_30',
      originalAudioRetention: 'indefinite',
    },
    backupScheduleEnabled: false,
    providers: [],
    credentialProviderIds: [],
    ...overrides,
  };
}

function repository(initial = persisted()) {
  let state = initial;
  const get = vi.fn(async () => state);
  const update = vi.fn(
    async (input: Parameters<SettingsRepository['update']>[0]) => {
      state = {
        ...state,
        revision: input.expectedRevision + 1,
        journalTimezone: input.request.journalTimezone,
        retention: input.request.retention,
        backupScheduleEnabled: input.request.backupScheduleEnabled,
      };
      return { revision: state.revision, replayed: false };
    },
  );
  const updateProvider = vi.fn(
    async (input: Parameters<SettingsRepository['updateProvider']>[0]) => {
      const prior = state.providers.find(
        (item) => item.providerId === input.providerId,
      );
      state = {
        ...state,
        revision: input.expectedRevision + 1,
        providers: [
          ...state.providers.filter(
            (item) => item.providerId !== input.providerId,
          ),
          {
            ownerId: input.ownerId,
            providerId: input.providerId,
            enabled: input.request.enabled,
            models: input.request.models,
            disclosureVersion:
              input.disclosureVersion ?? prior?.disclosureVersion ?? null,
            disclosureAcceptedAt:
              input.disclosureVersion === undefined
                ? (prior?.disclosureAcceptedAt ?? null)
                : input.now,
            revision: (prior?.revision ?? 0) + 1,
            updatedAt: input.now,
          },
        ],
        credentialProviderIds:
          input.request.clearCredential === true
            ? state.credentialProviderIds.filter(
                (providerId) => providerId !== input.providerId,
              )
            : input.credential === undefined
              ? state.credentialProviderIds
              : [
                  ...new Set([
                    ...state.credentialProviderIds,
                    input.providerId,
                  ]),
                ],
      };
      return { revision: state.revision, replayed: false };
    },
  );
  return { get, update, updateProvider };
}

function service(input?: {
  backupConfigured?: boolean;
  cipher?: ReturnType<typeof createProviderCredentialCipher>;
  initial?: PersistedSettings;
  synchronize?: (enabled: boolean) => Promise<void>;
}) {
  const store = repository(input?.initial);
  const instance = new PostgresSettingsService(
    {} as JournalDatabase,
    [descriptor],
    input?.backupConfigured ?? false,
    input?.cipher,
    input?.synchronize,
    () => NOW,
    store,
  );
  return { instance, store };
}

describe('settings service privacy and policy', () => {
  it('[SEC-003][SEC-006] encrypts credentials with authenticated randomized ciphertext and a stable secret fingerprint', () => {
    expect(() => createProviderCredentialCipher('too-short')).toThrow(
      SettingsValidationError,
    );
    const cipher = createProviderCredentialCipher(KEY);
    const first = cipher.encrypt(OWNER_ID, descriptor.id, 'private-key');
    const second = cipher.encrypt(OWNER_ID, descriptor.id, 'private-key');

    expect(first.ciphertext).not.toContain('private-key');
    expect(first).not.toEqual(second);
    expect(cipher.fingerprint('private-key')).toBe(
      cipher.fingerprint('private-key'),
    );
    expect(cipher.fingerprint('other-key')).not.toBe(
      cipher.fingerprint('private-key'),
    );
  });

  it('[SEC-004][SEC-006] versions exact disclosures and safely drops obsolete configured capabilities', async () => {
    const version = providerDisclosureVersion(descriptor);
    expect(version).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      providerDisclosureVersion({
        ...descriptor,
        disclosure: { ...descriptor.disclosure, contentRecipient: 'Changed' },
      }),
    ).not.toBe(version);

    const acceptedAt = new Date('2026-08-29T06:00:00.000Z');
    const { instance } = service({
      cipher: createProviderCredentialCipher(KEY),
      initial: persisted({
        providers: [
          {
            ownerId: OWNER_ID,
            providerId: descriptor.id,
            enabled: true,
            models: {
              speech_to_text: 'speech-v2',
              embeddings: 'obsolete-model',
            },
            disclosureVersion: version,
            disclosureAcceptedAt: acceptedAt,
            revision: 3,
            updatedAt: NOW,
          },
        ],
        credentialProviderIds: [descriptor.id],
      }),
    });

    await expect(instance.get(OWNER_ID)).resolves.toMatchObject({
      providers: [
        {
          enabled: true,
          models: { speech_to_text: 'speech-v2' },
          credentialConfigured: true,
          credentialStorageAvailable: true,
          disclosureAcceptedAt: acceptedAt.toISOString(),
        },
      ],
    });
  });

  it('[SEC-004][SEC-006] disables a persisted provider when its disclosure changes', async () => {
    const { instance } = service({
      initial: persisted({
        providers: [
          {
            ownerId: OWNER_ID,
            providerId: descriptor.id,
            enabled: true,
            models: {},
            disclosureVersion: 'a'.repeat(64),
            disclosureAcceptedAt: NOW,
            revision: 1,
            updatedAt: NOW,
          },
        ],
      }),
    });

    const result = await instance.get(OWNER_ID);
    expect(result.providers[0]).toMatchObject({ enabled: false });
    expect(result.providers[0]).not.toHaveProperty('disclosureAcceptedAt');
  });

  it('[TIME-001–TIME-003][PORT-001–PORT-002] validates mutable policy and synchronizes the durable backup schedule', async () => {
    const synchronize = vi.fn(async () => undefined);
    const { instance, store } = service({
      backupConfigured: true,
      synchronize,
    });
    const request = {
      journalTimezone: 'America/Chicago',
      retention: persisted().retention,
      backupScheduleEnabled: true,
    };
    const result = await instance.update(
      OWNER_ID,
      2,
      request,
      'settings-request-key',
      'correlation-id',
    );

    expect(result.settings).toMatchObject({
      revision: 3,
      journalTimezone: 'America/Chicago',
      backup: { scheduleEnabled: true },
    });
    expect(store.update).toHaveBeenCalledWith(
      expect.objectContaining({ request, now: NOW }),
    );
    expect(synchronize).toHaveBeenCalledWith(true);
    await expect(
      instance.update(
        OWNER_ID,
        3,
        { ...request, journalTimezone: 'not/a timezone' },
        'settings-bad-zone',
        'correlation-id',
      ),
    ).rejects.toThrow(/valid IANA timezone/u);
  });

  it('[PORT-001–PORT-002] rejects backup scheduling until encrypted backup storage is configured', async () => {
    const { instance } = service();
    await expect(
      instance.update(
        OWNER_ID,
        2,
        {
          journalTimezone: 'UTC',
          retention: persisted().retention,
          backupScheduleEnabled: true,
        },
        'settings-backup-key',
        'correlation-id',
      ),
    ).rejects.toThrow(/encrypted backup repository/u);
  });

  it('[SEC-003–SEC-006][MODEL-001–MODEL-006] requires current disclosure and passes only encrypted credential material to persistence', async () => {
    const cipher = createProviderCredentialCipher(KEY);
    const { instance, store } = service({ cipher });
    const request: UpdateProviderSettingsRequest = {
      enabled: true,
      models: { speech_to_text: 'speech-v2' },
      acknowledgeDisclosureVersion: providerDisclosureVersion(descriptor),
      credential: 'private-key-that-must-not-persist',
    };
    const result = await instance.updateProvider(
      OWNER_ID,
      descriptor.id,
      2,
      request,
      'provider-request-key',
      'correlation-id',
    );

    const persistedCall = store.updateProvider.mock.calls[0]?.[0];
    expect(persistedCall).toBeDefined();
    expect(JSON.stringify(persistedCall?.request)).not.toContain(
      request.credential,
    );
    expect(persistedCall?.credential?.ciphertext).not.toContain(
      request.credential,
    );
    expect(persistedCall?.disclosureVersion).toBe(
      request.acknowledgeDisclosureVersion,
    );
    expect(result.provider).toMatchObject({ id: descriptor.id });
  });

  it.each([
    [
      'missing adapter',
      'missing.provider',
      { enabled: false, models: {} },
      /not registered/u,
    ],
    [
      'unsupported model capability',
      descriptor.id,
      { enabled: false, models: { embeddings: 'embed-v1' } },
      /does not support embeddings/u,
    ],
    [
      'unaccepted disclosure',
      descriptor.id,
      { enabled: true, models: {} },
      /Accept the current provider disclosure/u,
    ],
    [
      'unavailable credential storage',
      descriptor.id,
      { enabled: false, models: {}, credential: 'private-key' },
      /credential storage is unavailable/u,
    ],
  ] as const)(
    '[SEC-003–SEC-006] rejects %s',
    async (_label, providerId, request, expected) => {
      const { instance } = service();
      await expect(
        instance.updateProvider(
          OWNER_ID,
          providerId,
          2,
          request,
          'provider-invalid-key',
          'correlation-id',
        ),
      ).rejects.toThrow(expected);
    },
  );
});
