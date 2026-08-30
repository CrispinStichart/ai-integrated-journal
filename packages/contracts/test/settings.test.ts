import { describe, expect, it } from 'vitest';

import {
  providerSettingsSchema,
  settingsResourceSchema,
  updateProviderSettingsRequestSchema,
  updateSettingsRequestSchema,
} from '../src/index.js';

describe('settings contracts', () => {
  it('[SEC-003–SEC-006][MODEL-001–MODEL-006] exposes disclosure, model identity, and only credential presence', () => {
    const provider = providerSettingsSchema.parse({
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
      disclosureVersion: 'a'.repeat(64),
      enabled: false,
      models: { speech_to_text: 'transcribe-v1' },
      credentialConfigured: true,
      credentialStorageAvailable: true,
      revision: 1,
    });

    expect(provider.credentialConfigured).toBe(true);
    expect(JSON.stringify(provider)).not.toContain('credentialValue');
    expect(() =>
      providerSettingsSchema.parse({ ...provider, credential: 'private-key' }),
    ).toThrow();
  });

  it('[RET-001–RET-007][PORT-001–PORT-008][TIME-001–TIME-003] bounds mutable owner policy', () => {
    expect(
      updateSettingsRequestSchema.parse({
        journalTimezone: 'America/Chicago',
        retention: {
          materialGraceDays: 30,
          audioGraceDays: 7,
          rawResponseRetention: 'do_not_retain',
          originalAudioRetention: '90_days',
        },
        backupScheduleEnabled: true,
      }),
    ).toMatchObject({ journalTimezone: 'America/Chicago' });
    expect(() =>
      updateSettingsRequestSchema.parse({
        journalTimezone: 'UTC',
        retention: {
          materialGraceDays: -1,
          audioGraceDays: 30,
          rawResponseRetention: 'days_30',
          originalAudioRetention: 'indefinite',
        },
        backupScheduleEnabled: false,
      }),
    ).toThrow();
  });

  it('[SEC-004][SEC-006] requires unambiguous write-only credential actions', () => {
    expect(() =>
      updateProviderSettingsRequestSchema.parse({
        enabled: false,
        models: {},
        credential: 'replace-me',
        clearCredential: true,
      }),
    ).toThrow(/cannot be replaced and cleared/u);
  });

  it('[SEC-001–SEC-007] publishes immutable privacy invariants', () => {
    const settings = settingsResourceSchema.parse({
      revision: 1,
      journalTimezone: 'UTC',
      retention: {
        materialGraceDays: 30,
        audioGraceDays: 30,
        rawResponseRetention: 'days_30',
        originalAudioRetention: 'indefinite',
      },
      backup: {
        configured: false,
        scheduleEnabled: false,
        schedule: '03:30 UTC daily',
        encrypted: true,
        retentionSummary: '7 daily, 5 weekly, and 12 monthly snapshots',
      },
      privacy: {
        journalPrivateByDefault: true,
        contentFreeLogs: true,
        credentialsExcludedFromExports: true,
        externalProcessingRequiresProviderEnablement: true,
        offlineCacheEncrypted: true,
      },
      providers: [],
    });
    expect(settings.privacy).toEqual({
      journalPrivateByDefault: true,
      contentFreeLogs: true,
      credentialsExcludedFromExports: true,
      externalProcessingRequiresProviderEnablement: true,
      offlineCacheEncrypted: true,
    });
  });
});
