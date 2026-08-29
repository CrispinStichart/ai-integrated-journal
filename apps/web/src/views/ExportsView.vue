<script setup lang="ts">
import type { ExportResource } from '@journal/contracts';
import { useIntervalFn } from '@vueuse/core';
import { computed, onMounted, ref } from 'vue';

import { useAuthentication } from '../auth';
import {
  createPortableExport,
  exportDownloadUrl,
  listPortableExports,
} from '../export/api';
import { useUiStore } from '../stores/ui';
import { createUuidV7 } from '../journal/api';

const auth = useAuthentication();
const ui = useUiStore();
const includeAudio = ref(false);
const includeProviderRawResponses = ref(false);
const exports = ref<ExportResource[]>([]);
const loading = ref(true);
const creating = ref(false);
const error = ref('');
const active = computed(() =>
  exports.value.some(
    (item) => item.status === 'queued' || item.status === 'running',
  ),
);

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatBytes(value?: string): string {
  if (value === undefined) return '—';
  const bytes = BigInt(value);
  const mebibyte = 1_048_576n;
  const divisor = bytes >= mebibyte ? mebibyte : 1_024n;
  const whole = bytes / divisor;
  const remainder = bytes % divisor;
  const tenths = (remainder * 10n) / divisor;
  const formatted = `${whole.toString()}${tenths === 0n ? '' : `.${tenths.toString()}`}`;
  return `${formatted} ${bytes >= mebibyte ? 'MB' : 'KB'}`;
}

async function refresh(): Promise<void> {
  try {
    exports.value = await listPortableExports();
    error.value = '';
  } catch {
    error.value = 'Export history could not be loaded.';
  } finally {
    loading.value = false;
  }
}

async function createExport(): Promise<void> {
  const csrfToken = auth.status.value?.csrfToken;
  if (!csrfToken) {
    error.value = 'Refresh your session before creating an export.';
    return;
  }
  creating.value = true;
  try {
    const created = await createPortableExport(
      {
        includeAudio: includeAudio.value,
        includeProviderRawResponses: includeProviderRawResponses.value,
      },
      csrfToken,
      `export-${createUuidV7()}`,
    );
    exports.value = [created, ...exports.value];
    ui.announce('Point-in-time export started.');
    error.value = '';
  } catch {
    error.value = 'The export could not be started.';
  } finally {
    creating.value = false;
  }
}

useIntervalFn(() => {
  if (active.value) void refresh();
}, 3_000);
onMounted(refresh);
</script>

<template>
  <section aria-labelledby="exports-title" class="space-y-8">
    <header>
      <p class="mb-2 text-sm font-medium text-base-content/60">Portability</p>
      <h1
        id="exports-title"
        class="text-3xl font-bold tracking-tight sm:text-4xl"
      >
        Exports
      </h1>
      <p class="mt-3 max-w-3xl text-base-content/70">
        Create a point-in-time ZIP with versioned JSON Lines, readable Journal
        Day Markdown, checksums, stable relationships, provenance, authority,
        and retention state.
      </p>
    </header>

    <div class="card card-border bg-base-100">
      <div class="card-body">
        <h2 class="card-title">New portable export</h2>
        <p class="text-sm text-base-content/70">
          Text, every retained revision, processor definitions, results,
          evidence, memories, provenance, and deletion metadata are always
          included.
        </p>
        <fieldset class="mt-3 space-y-4">
          <legend class="sr-only">Optional export content</legend>
          <label class="flex cursor-pointer items-start gap-3">
            <input
              v-model="includeAudio"
              type="checkbox"
              class="checkbox mt-0.5"
            />
            <span
              ><span class="font-medium">Include retained original audio</span
              ><span class="block text-sm text-base-content/60"
                >Audio is streamed into the archive and verified against its
                stored SHA-256.</span
              ></span
            >
          </label>
          <label class="flex cursor-pointer items-start gap-3">
            <input
              v-model="includeProviderRawResponses"
              type="checkbox"
              class="checkbox mt-0.5"
            />
            <span
              ><span class="font-medium"
                >Include retained provider raw responses</span
              ><span class="block text-sm text-base-content/60"
                >Off by default. These files may duplicate private journal
                content and contain provider metadata. Credentials and secret
                headers are never exported.</span
              ></span
            >
          </label>
        </fieldset>
        <div class="card-actions mt-3 justify-end">
          <button
            class="btn"
            type="button"
            :disabled="creating"
            @click="createExport"
          >
            <span
              v-if="creating"
              class="loading loading-spinner loading-sm"
              aria-hidden="true"
            />
            {{ creating ? 'Starting…' : 'Create export' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="error" class="alert alert-error" role="alert">
      <span>{{ error }}</span>
    </div>

    <section aria-labelledby="history-title">
      <div class="mb-3 flex items-center justify-between gap-3">
        <h2 id="history-title" class="text-xl font-semibold">Export history</h2>
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="loading"
          @click="refresh"
        >
          Refresh
        </button>
      </div>
      <div
        v-if="loading"
        class="flex min-h-32 items-center justify-center"
        role="status"
        aria-label="Loading exports"
      >
        <span class="loading loading-spinner" aria-hidden="true" />
      </div>
      <div v-else-if="exports.length === 0" class="alert" role="status">
        <span>No exports have been created.</span>
      </div>
      <ul
        v-else
        class="list rounded-box border border-base-300 bg-base-100"
        aria-label="Portable exports"
      >
        <li
          v-for="item in exports"
          :key="item.id"
          class="list-row items-center"
        >
          <span
            class="status"
            :class="{
              'status-success': item.status === 'completed',
              'status-warning':
                item.status === 'queued' || item.status === 'running',
              'status-error':
                item.status === 'failed' || item.status === 'invalidated',
            }"
            aria-hidden="true"
          />
          <div class="list-col-grow">
            <p class="font-medium">
              Snapshot {{ formatDate(item.snapshotAt) }}
            </p>
            <p class="text-sm text-base-content/60">
              {{ item.entityCount }} records ·
              {{ formatBytes(item.archiveByteSize) }} · manifest v{{
                item.manifestSchemaVersion
              }}
            </p>
            <p v-if="item.status === 'invalidated'" class="text-sm text-error">
              Invalidated because included material was permanently deleted.
            </p>
          </div>
          <span class="badge">{{ item.status }}</span>
          <a
            v-if="item.downloadAvailable"
            class="btn btn-sm"
            :href="exportDownloadUrl(item.id)"
            >Download ZIP</a
          >
        </li>
      </ul>
      <p class="mt-3 text-sm text-base-content/60">
        Downloads expire after 24 hours. A downloaded copy is outside the
        journal’s deletion control.
      </p>
    </section>
  </section>
</template>
