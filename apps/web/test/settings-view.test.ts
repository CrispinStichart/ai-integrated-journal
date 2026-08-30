// @vitest-environment jsdom

import type { SettingsResource } from '@journal/contracts';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import axe from 'axe-core';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateProviderSettings: vi.fn(),
  listActiveSessions: vi.fn(),
  revokeActiveSession: vi.fn(),
  getNudgePreferences: vi.fn(),
  updateNudgePreferences: vi.fn(),
  offlineSetup: vi.fn(),
  offlineUnlock: vi.fn(),
  clearReadCache: vi.fn(),
  lock: vi.fn(),
}));

vi.mock('../src/auth', () => ({
  useAuthentication: () => ({
    status: ref({ csrfToken: 'csrf-token' }),
    initialize: vi.fn(),
  }),
}));
vi.mock('../src/journal/api', () => ({
  createUuidV7: () => '019c5b90-0000-7000-8000-000000000099',
}));
vi.mock('../src/journal/offline', () => ({
  useOfflineJournal: () => ({
    configured: ref(true),
    unlocked: ref(true),
    pendingCount: ref(2),
    cacheBytes: ref(2048),
    cacheDays: ref(3),
    setup: mocks.offlineSetup,
    unlock: mocks.offlineUnlock,
    clearReadCache: mocks.clearReadCache,
    lock: mocks.lock,
    logout: vi.fn(),
  }),
}));
vi.mock('../src/settings/api', () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
  updateProviderSettings: mocks.updateProviderSettings,
  listActiveSessions: mocks.listActiveSessions,
  revokeActiveSession: mocks.revokeActiveSession,
}));
vi.mock('../src/nudge/api', () => ({
  getNudgePreferences: mocks.getNudgePreferences,
  updateNudgePreferences: mocks.updateNudgePreferences,
}));
vi.mock('../src/stores/ui', () => ({
  useUiStore: () => ({ announce: vi.fn() }),
}));

import SettingsView from '../src/views/SettingsView.vue';

const settings: SettingsResource = {
  revision: 3,
  journalTimezone: 'UTC',
  retention: {
    materialGraceDays: 30,
    audioGraceDays: 30,
    rawResponseRetention: 'days_30',
    originalAudioRetention: 'indefinite',
  },
  backup: {
    configured: true,
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
  providers: [
    {
      id: 'synthetic.external',
      displayName: 'Synthetic external provider',
      capabilities: ['speech_to_text'],
      disclosure: {
        contentRecipient: 'Synthetic Corp',
        external: true,
        retention: {
          status: 'known',
          value: 'Provider retains data for 30 days.',
        },
        trainingUse: { status: 'unknown' },
        privacyPolicyUrl: 'https://provider.example/privacy',
      },
      disclosureVersion: 'a'.repeat(64),
      enabled: false,
      models: { speech_to_text: 'speech-v1' },
      credentialConfigured: false,
      credentialStorageAvailable: true,
      revision: 1,
    },
  ],
};

function mountView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = mount(SettingsView, {
    attachTo: document.body,
    global: {
      plugins: [[VueQueryPlugin, { queryClient }]],
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
      },
    },
  });
  return { wrapper, queryClient };
}

describe('settings and privacy UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue(settings);
    mocks.updateSettings.mockResolvedValue({ ...settings, revision: 4 });
    mocks.updateProviderSettings.mockResolvedValue(undefined);
    mocks.listActiveSessions.mockResolvedValue([
      {
        id: '019c5b90-0000-7000-8000-000000000081',
        current: true,
        createdAt: '2026-08-30T01:00:00.000Z',
        lastUsedAt: '2026-08-30T02:00:00.000Z',
        idleExpiresAt: '2026-08-30T02:30:00.000Z',
        absoluteExpiresAt: '2026-09-06T01:00:00.000Z',
      },
    ]);
    mocks.getNudgePreferences.mockResolvedValue({
      quietStartHour: 21,
      quietEndHour: 8,
      dailyLimit: 1,
      revision: 1,
      ownerTimezone: 'UTC',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
  });

  it('[SEC-001–SEC-006][RET-001–RET-007][PORT-001–PORT-008] discloses privacy and lifecycle controls accessibly', async () => {
    const { wrapper, queryClient } = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('Synthetic external provider');
    expect(wrapper.text()).toContain('Training use is unknown');
    expect(wrapper.text()).toContain('Pending recovery items');
    expect(wrapper.text()).toContain('Credentials are encrypted separately');
    expect(wrapper.text()).toContain('Active sessions');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    queryClient.clear();
    wrapper.unmount();
  });

  it('[TIME-001–TIME-003][PORT-001–PORT-002] saves timezone, retention, and backup with the current revision', async () => {
    const { wrapper, queryClient } = mountView();
    await flushPromises();
    await wrapper.get('#journal-timezone').setValue('America/Chicago');
    await wrapper.get('#material-grace').setValue('14');
    await wrapper.get('input[type="checkbox"].toggle').setValue(true);
    const settingsForm = wrapper.findAll('form')[0];
    if (settingsForm === undefined) throw new Error('settings form missing');
    await settingsForm.trigger('submit');
    await flushPromises();

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        settings,
        changes: expect.objectContaining({
          journalTimezone: 'America/Chicago',
          backupScheduleEnabled: true,
          retention: expect.objectContaining({ materialGraceDays: 14 }),
        }),
        csrfToken: 'csrf-token',
      }),
    );
    queryClient.clear();
    wrapper.unmount();
  });

  it('[SEC-003–SEC-006][MODEL-001–MODEL-006] sends disclosure acknowledgement and write-only credential explicitly', async () => {
    const { wrapper, queryClient } = mountView();
    await flushPromises();
    const providerForm = wrapper
      .findAll('form')
      .find((form) => form.text().includes('Synthetic external provider'));
    if (providerForm === undefined) throw new Error('provider form missing');
    const toggles = providerForm.findAll('input[type="checkbox"]');
    const enabledToggle = toggles[0];
    const disclosureCheckbox = toggles[1];
    if (enabledToggle === undefined || disclosureCheckbox === undefined)
      throw new Error('provider controls missing');
    await enabledToggle.setValue(true);
    await disclosureCheckbox.setValue(true);
    await providerForm.get('input[type="password"]').setValue('private-key');
    await providerForm.trigger('submit');
    await flushPromises();

    expect(mocks.updateProviderSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'synthetic.external',
        changes: expect.objectContaining({
          enabled: true,
          acknowledgeDisclosureVersion: 'a'.repeat(64),
          credential: 'private-key',
        }),
      }),
    );
    expect(wrapper.html()).not.toContain('value="private-key"');
    queryClient.clear();
    wrapper.unmount();
  });
});
