<script setup lang="ts">
import { useDocumentVisibility, useOnline } from '@vueuse/core';
import { nextTick, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';

import AppIcon, { type IconName } from './components/AppIcon.vue';
import AppStatus from './components/AppStatus.vue';
import PwaUpdateDialog from './components/PwaUpdateDialog.vue';
import { useAuthentication } from './auth';
import { useOfflineJournal } from './journal/offline';
import { useBrowserCaptureController } from './recording/capture-controller';
import { useRecordingSyncController } from './recording/sync-controller';
import {
  acknowledgeDeletionLedger,
  drainDeletionLedger,
} from './retention/api';
import { useUiStore } from './stores/ui';
import { browserMetadata } from './storage/indexed-db';
import AuthenticationView from './views/AuthenticationView.vue';

interface NavigationItem {
  icon: IconName;
  label: string;
  to: string;
}

const navigationItems: NavigationItem[] = [
  { icon: 'today', label: 'Today', to: '/' },
  { icon: 'calendar', label: 'Calendar', to: '/calendar' },
  { icon: 'search', label: 'Search', to: '/search' },
  { icon: 'activity', label: 'Activity', to: '/activity' },
  { icon: 'processors', label: 'Processors', to: '/processors' },
  { icon: 'memories', label: 'Memories & rules', to: '/memories' },
  { icon: 'exports', label: 'Exports & backups', to: '/exports' },
  { icon: 'settings', label: 'Settings', to: '/settings' },
];

const dockItems = navigationItems.slice(0, 4);
const route = useRoute();
const ui = useUiStore();
const online = useOnline();
const visibility = useDocumentVisibility();
const auth = useAuthentication();
const offline = useOfflineJournal();
const capture = useBrowserCaptureController();
const recordingSync = useRecordingSyncController();
const TOMBSTONE_GENERATION_KEY = 'retention-tombstone-generation';

async function resumeOfflineWork(): Promise<void> {
  const ownerId = auth.status.value?.ownerId;
  const csrfToken = auth.status.value?.csrfToken;
  if (ownerId === undefined || csrfToken === undefined) return;
  await offline.initialize(ownerId);
  const initialGeneration =
    (await browserMetadata.get<number>(TOMBSTONE_GENERATION_KEY)) ?? 0;
  const { appliedGeneration, latestGeneration } = await drainDeletionLedger(
    initialGeneration,
    async (items, pageGeneration) => {
      await offline.applyDeletionTombstones(items);
      await browserMetadata.set(TOMBSTONE_GENERATION_KEY, pageGeneration);
      if (!('caches' in window)) return;
      await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
    },
  );
  if (
    latestGeneration > initialGeneration &&
    appliedGeneration === latestGeneration
  ) {
    await acknowledgeDeletionLedger(appliedGeneration, csrfToken);
  }
  await offline.replay(csrfToken);
  await recordingSync.initialize(ownerId, csrfToken);
  if (offline.unlocked.value) await recordingSync.resume();
}

void auth.initialize().then(resumeOfflineWork);

async function logout(): Promise<void> {
  try {
    await offline.logout();
    await auth.logout();
  } catch {
    ui.announce('Logout failed. Please try again.');
  }
}

watch(online, (available, wasAvailable) => {
  if (available && !wasAvailable) void resumeOfflineWork();
});

watch(visibility, (value) => {
  if (value === 'visible') {
    void resumeOfflineWork();
    void capture.checkStorage();
  }
});

async function registerPasskey(): Promise<void> {
  try {
    await auth.registerPasskey();
    ui.announce('Passkey added. Your session was securely rotated.');
  } catch {
    ui.announce('Passkey setup was not completed.');
  }
}

watch(
  () => route.fullPath,
  async () => {
    ui.closeNavigation();
    ui.announce(`${String(route.meta.title ?? 'Journal')} page loaded`);
    await nextTick();
    document.querySelector<HTMLElement>('#main-content')?.focus();
  },
);
</script>

<template>
  <div
    v-if="auth.loading.value"
    class="flex min-h-screen items-center justify-center bg-base-100"
    role="status"
    aria-label="Checking authentication"
  >
    <span class="loading loading-spinner loading-lg" aria-hidden="true" />
  </div>

  <AuthenticationView
    v-else-if="!auth.authenticated.value || auth.recoveryCodes.value.length > 0"
  />

  <template v-else>
    <a
      class="btn btn-sm fixed top-2 left-2 z-50 -translate-y-20 focus:translate-y-0"
      href="#main-content"
    >
      Skip to content
    </a>

    <div class="drawer lg:drawer-open">
      <input
        id="application-navigation"
        v-model="ui.navigationOpen"
        type="checkbox"
        class="drawer-toggle"
        aria-label="Application navigation"
      />

      <div
        class="drawer-content flex min-h-screen min-w-0 flex-col bg-base-100 text-base-content"
      >
        <header
          class="navbar sticky top-0 z-30 border-b border-base-300 bg-base-100/95 px-3 backdrop-blur sm:px-6"
        >
          <div class="navbar-start gap-2">
            <label
              for="application-navigation"
              class="btn btn-square btn-ghost drawer-button lg:hidden"
              aria-label="Open navigation"
            >
              <AppIcon name="menu" />
            </label>
            <RouterLink to="/" class="text-lg font-semibold tracking-tight"
              >Journal</RouterLink
            >
          </div>

          <div class="navbar-end gap-2">
            <AppStatus
              :label="online ? 'Network available' : 'Offline'"
              :tone="online ? 'success' : 'warning'"
              :detail="
                online
                  ? 'The browser reports network access'
                  : 'Only offline-ready features are available'
              "
            />
            <button
              v-if="(auth.status.value?.passkeyCount ?? 0) === 0"
              class="btn btn-sm"
              type="button"
              @click="registerPasskey"
            >
              Add passkey
            </button>
            <button class="btn btn-ghost btn-sm" type="button" @click="logout">
              Log out
            </button>
          </div>
        </header>

        <main
          id="main-content"
          tabindex="-1"
          class="mx-auto w-full max-w-6xl grow px-4 pt-8 pb-28 outline-none sm:px-6 lg:pb-10"
        >
          <RouterView v-slot="{ Component }">
            <Suspense>
              <component :is="Component" />
              <template #fallback>
                <div
                  class="flex min-h-64 items-center justify-center"
                  role="status"
                  aria-label="Loading page"
                >
                  <span
                    class="loading loading-spinner loading-lg"
                    aria-hidden="true"
                  />
                </div>
              </template>
            </Suspense>
          </RouterView>
        </main>

        <nav
          class="dock dock-sm border-t border-base-300 bg-base-100 lg:hidden"
          aria-label="Primary navigation"
        >
          <RouterLink
            v-for="item in dockItems"
            :key="item.to"
            :to="item.to"
            :class="{ 'dock-active': route.path === item.to }"
            :aria-current="route.path === item.to ? 'page' : undefined"
          >
            <AppIcon :name="item.icon" />
            <span class="dock-label">{{ item.label }}</span>
          </RouterLink>
        </nav>
      </div>

      <div class="drawer-side z-40">
        <label
          for="application-navigation"
          aria-label="Close navigation"
          class="drawer-overlay"
        />
        <aside
          class="flex min-h-full w-72 flex-col bg-base-200 p-4 text-base-content"
        >
          <RouterLink
            to="/"
            class="mb-6 flex items-center gap-3 px-3 py-2 text-xl font-bold"
          >
            <span
              class="grid size-10 place-items-center rounded-box bg-primary text-primary-content"
              aria-hidden="true"
              >J</span
            >
            Journal
          </RouterLink>
          <nav aria-label="Application sections">
            <ul class="menu w-full gap-1">
              <li v-for="item in navigationItems" :key="item.to">
                <RouterLink
                  :to="item.to"
                  :class="{ 'menu-active': route.path === item.to }"
                  :aria-current="route.path === item.to ? 'page' : undefined"
                >
                  <AppIcon :name="item.icon" />
                  {{ item.label }}
                </RouterLink>
              </li>
            </ul>
          </nav>
          <p class="mt-auto px-3 pt-8 text-xs text-base-content/60">
            Private, local-first journaling
          </p>
        </aside>
      </div>
    </div>

    <p class="sr-only" aria-live="polite" aria-atomic="true">
      {{ ui.liveMessage }}
    </p>
    <PwaUpdateDialog />
  </template>
</template>
