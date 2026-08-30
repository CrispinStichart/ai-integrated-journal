<script setup lang="ts">
import type {
  ProviderCapability,
  ProviderSettings,
  SettingsResource,
} from '@journal/contracts';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import NudgePreferencesCard from '../components/NudgePreferencesCard.vue';
import { useAuthentication } from '../auth';
import { createUuidV7 } from '../journal/api';
import { useOfflineJournal } from '../journal/offline';
import {
  getSettings,
  listActiveSessions,
  revokeActiveSession,
  updateProviderSettings,
  updateSettings,
} from '../settings/api';
import { useUiStore } from '../stores/ui';

const capabilityLabels: Record<ProviderCapability, string> = {
  embeddings: 'Embeddings',
  speech_to_text: 'Speech to text',
  structured_generation: 'Structured generation',
};

const auth = useAuthentication();
const offline = useOfflineJournal();
const ui = useUiStore();
const queryClient = useQueryClient();
const query = useQuery({ queryKey: ['settings'], queryFn: getSettings });
const sessionsQuery = useQuery({
  queryKey: ['active-sessions'],
  queryFn: listActiveSessions,
});
const preferencesBusy = ref(false);
const preferencesError = ref('');
const localSecret = ref('');
const localBusy = ref(false);
const localError = ref('');
const revokingSession = ref('');
const sessionError = ref('');
const providerBusy = ref('');
const providerError = ref('');
interface ProviderDraft {
  enabled: boolean;
  models: Partial<Record<ProviderCapability, string>>;
  accepted: boolean;
  credential: string;
  clearCredential: boolean;
}
const providerDrafts = reactive<Record<string, ProviderDraft>>({});
const form = reactive({
  journalTimezone: 'UTC',
  materialGraceDays: 30,
  audioGraceDays: 30,
  rawResponseRetention:
    'days_30' as SettingsResource['retention']['rawResponseRetention'],
  originalAudioRetention:
    'indefinite' as SettingsResource['retention']['originalAudioRetention'],
  backupScheduleEnabled: false,
});

watch(
  () => query.data.value,
  (settings) => {
    if (settings === undefined) return;
    form.journalTimezone = settings.journalTimezone;
    form.materialGraceDays = settings.retention.materialGraceDays;
    form.audioGraceDays = settings.retention.audioGraceDays;
    form.rawResponseRetention = settings.retention.rawResponseRetention;
    form.originalAudioRetention = settings.retention.originalAudioRetention;
    form.backupScheduleEnabled = settings.backup.scheduleEnabled;
    for (const provider of settings.providers) {
      providerDrafts[provider.id] = {
        enabled: provider.enabled,
        models: { ...provider.models },
        accepted: provider.disclosureAcceptedAt !== undefined,
        credential: '',
        clearCredential: false,
      };
    }
  },
  { immediate: true },
);

const cacheUsage = computed(() => {
  const bytes = offline.cacheBytes.value;
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
});
const configuredProviders = computed(() =>
  (query.data.value?.providers ?? [])
    .map((provider) => ({ provider, draft: providerDrafts[provider.id] }))
    .filter(
      (item): item is { provider: ProviderSettings; draft: ProviderDraft } =>
        item.draft !== undefined,
    ),
);

function providerTraining(provider: ProviderSettings): string {
  return provider.disclosure.trainingUse.status === 'known'
    ? provider.disclosure.trainingUse.value
      ? 'Provider may use submitted content for training.'
      : 'Provider states submitted content is not used for training.'
    : 'Training use is unknown.';
}

function providerRetention(provider: ProviderSettings): string {
  return provider.disclosure.retention.status === 'known'
    ? provider.disclosure.retention.value
    : 'Provider retention is unknown.';
}

async function savePreferences(): Promise<void> {
  const settings = query.data.value;
  const csrfToken = auth.status.value?.csrfToken;
  if (settings === undefined || csrfToken === undefined) return;
  preferencesBusy.value = true;
  preferencesError.value = '';
  try {
    const updated = await updateSettings({
      settings,
      changes: {
        journalTimezone: form.journalTimezone,
        retention: {
          materialGraceDays: form.materialGraceDays,
          audioGraceDays: form.audioGraceDays,
          rawResponseRetention: form.rawResponseRetention,
          originalAudioRetention: form.originalAudioRetention,
        },
        backupScheduleEnabled: form.backupScheduleEnabled,
      },
      csrfToken,
      idempotencyKey: `settings-${createUuidV7()}`,
    });
    queryClient.setQueryData(['settings'], updated);
    ui.announce('Journal, retention, and backup settings saved');
  } catch (error) {
    preferencesError.value =
      error instanceof Error ? error.message : 'Settings could not be saved.';
  } finally {
    preferencesBusy.value = false;
  }
}

async function saveProvider(provider: ProviderSettings): Promise<void> {
  const settings = query.data.value;
  const csrfToken = auth.status.value?.csrfToken;
  const draft = providerDrafts[provider.id];
  if (settings === undefined || csrfToken === undefined || draft === undefined)
    return;
  providerBusy.value = provider.id;
  providerError.value = '';
  try {
    await updateProviderSettings({
      settings,
      providerId: provider.id,
      changes: {
        enabled: draft.enabled,
        models: draft.models,
        ...(draft.accepted
          ? { acknowledgeDisclosureVersion: provider.disclosureVersion }
          : {}),
        ...(draft.credential === '' ? {} : { credential: draft.credential }),
        ...(draft.clearCredential ? { clearCredential: true } : {}),
      },
      csrfToken,
      idempotencyKey: `provider-settings-${createUuidV7()}`,
    });
    draft.credential = '';
    draft.clearCredential = false;
    await query.refetch();
    ui.announce(`${provider.displayName} settings saved`);
  } catch (error) {
    providerError.value =
      error instanceof Error
        ? error.message
        : 'Provider settings could not be saved.';
  } finally {
    providerBusy.value = '';
  }
}

async function submitLocalSecret(): Promise<void> {
  localBusy.value = true;
  localError.value = '';
  try {
    if (offline.configured.value) await offline.unlock(localSecret.value);
    else await offline.setup(localSecret.value);
    localSecret.value = '';
    ui.announce('Encrypted offline storage unlocked');
  } catch (error) {
    localError.value =
      error instanceof Error ? error.message : 'Offline storage failed.';
  } finally {
    localBusy.value = false;
  }
}

async function clearCache(): Promise<void> {
  localBusy.value = true;
  localError.value = '';
  try {
    await offline.clearReadCache();
    ui.announce('Offline Journal Day cache cleared');
  } catch (error) {
    localError.value =
      error instanceof Error ? error.message : 'Cache could not be cleared.';
  } finally {
    localBusy.value = false;
  }
}

async function revokeSession(sessionId: string): Promise<void> {
  const csrfToken = auth.status.value?.csrfToken;
  if (csrfToken === undefined) return;
  revokingSession.value = sessionId;
  sessionError.value = '';
  try {
    const result = await revokeActiveSession({ sessionId, csrfToken });
    if (result.currentSession) {
      await offline.logout();
      if ('caches' in window)
        await Promise.all(
          (await caches.keys()).map((key) => caches.delete(key)),
        );
      await auth.initialize();
      return;
    }
    await sessionsQuery.refetch();
    ui.announce('Session revoked');
  } catch (error) {
    sessionError.value =
      error instanceof Error ? error.message : 'Session could not be revoked.';
  } finally {
    revokingSession.value = '';
  }
}
</script>

<template>
  <section aria-labelledby="settings-title" class="space-y-8">
    <header>
      <p class="mb-2 text-sm font-medium text-base-content/60">Journal</p>
      <h1
        id="settings-title"
        class="text-3xl font-bold tracking-tight sm:text-4xl"
      >
        Settings
      </h1>
      <p class="mt-3 max-w-3xl text-base-content/70">
        Control what stays local, what an external provider may receive, and how
        long recoverable material remains.
      </p>
    </header>

    <div
      v-if="query.isLoading.value"
      role="status"
      class="flex items-center gap-3"
    >
      <span class="loading loading-spinner" aria-hidden="true" />
      Loading settings
    </div>
    <div v-else-if="query.isError.value" role="alert" class="alert alert-error">
      Settings could not be loaded. Refresh the page to try again.
    </div>

    <template v-else-if="query.data.value">
      <form
        class="card card-border bg-base-100"
        aria-labelledby="journal-settings-title"
        @submit.prevent="savePreferences"
      >
        <div class="card-body">
          <h2 id="journal-settings-title" class="card-title">
            Journal and retention
          </h2>
          <p class="text-sm text-base-content/70">
            Timezone changes apply only to future default assignments. Existing
            contributions never move silently.
          </p>
          <div class="grid gap-4 md:grid-cols-2">
            <fieldset class="fieldset md:col-span-2">
              <legend class="fieldset-legend">
                <label for="journal-timezone">Journal timezone</label>
              </legend>
              <input
                id="journal-timezone"
                v-model.trim="form.journalTimezone"
                class="input w-full"
                autocomplete="off"
                required
              />
              <p class="label">
                Use an IANA name such as America/New_York or Europe/London.
              </p>
            </fieldset>
            <fieldset class="fieldset">
              <legend class="fieldset-legend">
                <label for="material-grace">Journal deletion grace days</label>
              </legend>
              <input
                id="material-grace"
                v-model.number="form.materialGraceDays"
                class="input w-full"
                type="number"
                min="0"
                max="3650"
                required
              />
            </fieldset>
            <fieldset class="fieldset">
              <legend class="fieldset-legend">
                <label for="audio-grace">Audio deletion grace days</label>
              </legend>
              <input
                id="audio-grace"
                v-model.number="form.audioGraceDays"
                class="input w-full"
                type="number"
                min="0"
                max="3650"
                required
              />
            </fieldset>
            <fieldset class="fieldset">
              <legend class="fieldset-legend">
                <label for="audio-retention">Original audio retention</label>
              </legend>
              <select
                id="audio-retention"
                v-model="form.originalAudioRetention"
                class="select w-full"
              >
                <option value="indefinite">Keep indefinitely</option>
                <option value="30_days">30 days</option>
                <option value="90_days">90 days</option>
                <option value="365_days">1 year</option>
              </select>
            </fieldset>
            <fieldset class="fieldset">
              <legend class="fieldset-legend">
                <label for="raw-retention"
                  >Raw provider response retention</label
                >
              </legend>
              <select
                id="raw-retention"
                v-model="form.rawResponseRetention"
                class="select w-full"
              >
                <option value="do_not_retain">Do not retain</option>
                <option value="days_30">30 days</option>
                <option value="days_90">90 days</option>
                <option value="year_1">1 year</option>
                <option value="indefinite">Keep indefinitely</option>
              </select>
              <p class="label">
                Normalized results and source revisions have separate
                lifecycles.
              </p>
            </fieldset>
          </div>
          <div class="divider" />
          <div
            class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
          >
            <div>
              <h3 class="font-semibold">Encrypted backup automation</h3>
              <p class="text-sm text-base-content/70">
                {{ query.data.value.backup.schedule }} ·
                {{ query.data.value.backup.retentionSummary }}.
              </p>
              <p
                v-if="!query.data.value.backup.configured"
                class="mt-1 text-sm text-warning"
              >
                Configure the restic repository and secret file on the host
                first.
              </p>
            </div>
            <label class="label cursor-pointer gap-3">
              <span>Run daily backup</span>
              <input
                v-model="form.backupScheduleEnabled"
                class="toggle"
                type="checkbox"
                :disabled="!query.data.value.backup.configured"
              />
            </label>
          </div>
          <p v-if="preferencesError" role="alert" class="text-sm text-error">
            {{ preferencesError }}
          </p>
          <div class="card-actions justify-end">
            <button class="btn" type="submit" :disabled="preferencesBusy">
              {{ preferencesBusy ? 'Saving…' : 'Save journal settings' }}
            </button>
          </div>
        </div>
      </form>

      <section aria-labelledby="providers-title" class="space-y-4">
        <div>
          <h2 id="providers-title" class="text-2xl font-bold">
            AI providers and models
          </h2>
          <p class="mt-1 text-sm text-base-content/70">
            Providers remain off until you accept their current disclosure.
            Journal capture and editing continue without them.
          </p>
        </div>
        <div
          v-if="query.data.value.providers.length === 0"
          role="status"
          class="alert"
        >
          No provider adapters are installed. No journal content can be sent to
          an external model.
        </div>
        <form
          v-for="{ provider, draft } in configuredProviders"
          v-else
          :key="provider.id"
          class="card card-border bg-base-100"
          :aria-labelledby="`provider-${provider.id}-title`"
          @submit.prevent="saveProvider(provider)"
        >
          <div class="card-body">
            <div
              class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div>
                <h3 :id="`provider-${provider.id}-title`" class="card-title">
                  {{ provider.displayName }}
                </h3>
                <p class="text-sm text-base-content/70">
                  Content recipient: {{ provider.disclosure.contentRecipient }}
                </p>
              </div>
              <label class="label cursor-pointer gap-3">
                <span>Provider enabled</span>
                <input v-model="draft.enabled" class="toggle" type="checkbox" />
              </label>
            </div>
            <div class="alert alert-warning alert-soft">
              <div>
                <p>{{ providerRetention(provider) }}</p>
                <p>{{ providerTraining(provider) }}</p>
                <a
                  v-if="provider.disclosure.privacyPolicyUrl"
                  class="link"
                  :href="provider.disclosure.privacyPolicyUrl"
                  target="_blank"
                  rel="noreferrer"
                  >Provider privacy policy</a
                >
              </div>
            </div>
            <label class="label cursor-pointer justify-start gap-3">
              <input
                v-model="draft.accepted"
                class="checkbox"
                type="checkbox"
                :disabled="provider.disclosureAcceptedAt !== undefined"
              />
              <span>{{
                provider.disclosureAcceptedAt
                  ? 'Current disclosure accepted.'
                  : 'I understand which content this provider receives and its disclosed retention/training terms.'
              }}</span>
            </label>
            <div class="grid gap-4 md:grid-cols-2">
              <fieldset
                v-for="capability in provider.capabilities"
                :key="capability"
                class="fieldset"
              >
                <legend class="fieldset-legend">
                  <label :for="`${provider.id}-${capability}-model`">
                    {{ capabilityLabels[capability] }} model
                  </label>
                </legend>
                <input
                  :id="`${provider.id}-${capability}-model`"
                  v-model.trim="draft.models[capability]"
                  class="input w-full"
                  autocomplete="off"
                  placeholder="Provider model ID"
                />
              </fieldset>
              <fieldset class="fieldset">
                <legend class="fieldset-legend">
                  <label :for="`${provider.id}-credential`"
                    >Replace credential</label
                  >
                </legend>
                <input
                  :id="`${provider.id}-credential`"
                  v-model="draft.credential"
                  class="input w-full"
                  type="password"
                  autocomplete="new-password"
                  :disabled="!provider.credentialStorageAvailable"
                />
                <p class="label">
                  {{
                    provider.credentialConfigured
                      ? 'A credential is stored. Its value can never be viewed.'
                      : 'No credential stored.'
                  }}
                </p>
              </fieldset>
            </div>
            <label
              v-if="provider.credentialConfigured"
              class="label cursor-pointer justify-start gap-3"
            >
              <input
                v-model="draft.clearCredential"
                class="checkbox"
                type="checkbox"
              />
              <span>Remove the stored credential</span>
            </label>
            <p
              v-if="providerError && providerBusy === provider.id"
              role="alert"
              class="text-sm text-error"
            >
              {{ providerError }}
            </p>
            <div class="card-actions justify-end">
              <button class="btn" type="submit" :disabled="providerBusy !== ''">
                {{
                  providerBusy === provider.id
                    ? 'Saving…'
                    : `Save ${provider.displayName}`
                }}
              </button>
            </div>
          </div>
        </form>
      </section>

      <div class="grid gap-6 lg:grid-cols-2">
        <section
          class="card card-border bg-base-100"
          aria-labelledby="offline-title"
        >
          <div class="card-body">
            <h2 id="offline-title" class="card-title">
              Encrypted offline storage
            </h2>
            <p class="text-sm text-base-content/70">
              Cached Journal Days expire after 30 days and are bounded to 200
              days. Pending notes and recording chunks are recovery data and are
              never evicted automatically.
            </p>
            <dl class="grid grid-cols-2 gap-2 text-sm">
              <dt>Read cache</dt>
              <dd>{{ offline.cacheDays.value }} days · {{ cacheUsage }}</dd>
              <dt>Pending recovery items</dt>
              <dd>{{ offline.pendingCount.value }}</dd>
              <dt>Local lock</dt>
              <dd>{{ offline.unlocked.value ? 'Unlocked' : 'Locked' }}</dd>
            </dl>
            <form
              v-if="!offline.unlocked.value"
              class="space-y-3"
              @submit.prevent="submitLocalSecret"
            >
              <fieldset class="fieldset">
                <legend class="fieldset-legend">
                  <label for="local-unlock">{{
                    offline.configured.value
                      ? 'Local unlock secret'
                      : 'Create local unlock secret'
                  }}</label>
                </legend>
                <input
                  id="local-unlock"
                  v-model="localSecret"
                  class="input w-full"
                  type="password"
                  autocomplete="current-password"
                  minlength="8"
                  required
                />
                <p v-if="!offline.configured.value" class="label">
                  This is separate from your account password. Losing it
                  destroys access to unsynced local-only work.
                </p>
              </fieldset>
              <button class="btn" type="submit" :disabled="localBusy">
                {{
                  offline.configured.value
                    ? 'Unlock local storage'
                    : 'Enable offline storage'
                }}
              </button>
            </form>
            <div v-else class="card-actions">
              <button class="btn" type="button" @click="offline.lock">
                Lock now
              </button>
              <button
                class="btn btn-outline"
                type="button"
                :disabled="localBusy"
                @click="clearCache"
              >
                Clear read cache
              </button>
            </div>
            <p v-if="localError" role="alert" class="text-sm text-error">
              {{ localError }}
            </p>
          </div>
        </section>

        <section
          class="card card-border bg-base-100"
          aria-labelledby="privacy-title"
        >
          <div class="card-body">
            <h2 id="privacy-title" class="card-title">Privacy guarantees</h2>
            <ul class="list">
              <li class="list-row">Journal content is private by default.</li>
              <li class="list-row">
                Logs and metrics exclude journal text, audio, prompts,
                responses, and credentials.
              </li>
              <li class="list-row">
                Credentials are encrypted separately and never appear in
                responses or exports.
              </li>
              <li class="list-row">
                Downloaded exports are outside deletion and cache controls.
              </li>
            </ul>
            <div class="card-actions">
              <RouterLink class="btn" to="/exports"
                >Open export controls</RouterLink
              >
            </div>
          </div>
        </section>
      </div>

      <NudgePreferencesCard />

      <section
        class="card card-border bg-base-100"
        aria-labelledby="sessions-title"
      >
        <div class="card-body">
          <h2 id="sessions-title" class="card-title">Active sessions</h2>
          <p class="text-sm text-base-content/70">
            Revoke access you no longer recognize. Revoking this session locks
            local data and returns to sign in.
          </p>
          <div v-if="sessionsQuery.isLoading.value" role="status">
            Loading active sessions
          </div>
          <div
            v-else-if="sessionsQuery.isError.value"
            role="alert"
            class="alert alert-error"
          >
            Active sessions could not be loaded.
          </div>
          <ul v-else class="list" aria-label="Active sessions">
            <li
              v-for="session in sessionsQuery.data.value ?? []"
              :key="session.id"
              class="list-row"
            >
              <div class="list-col-grow">
                <p class="font-medium">
                  {{ session.current ? 'This session' : 'Signed-in session' }}
                  <span v-if="session.current" class="badge badge-soft"
                    >Current</span
                  >
                </p>
                <p class="text-xs text-base-content/60">
                  Last used
                  {{ new Date(session.lastUsedAt).toLocaleString() }} · expires
                  {{ new Date(session.absoluteExpiresAt).toLocaleString() }}
                </p>
              </div>
              <button
                class="btn btn-sm"
                type="button"
                :disabled="revokingSession !== ''"
                :aria-label="
                  session.current
                    ? 'Revoke this session'
                    : 'Revoke signed-in session'
                "
                @click="revokeSession(session.id)"
              >
                {{ revokingSession === session.id ? 'Revoking…' : 'Revoke' }}
              </button>
            </li>
          </ul>
          <p v-if="sessionError" role="alert" class="text-sm text-error">
            {{ sessionError }}
          </p>
        </div>
      </section>
    </template>
  </section>
</template>
