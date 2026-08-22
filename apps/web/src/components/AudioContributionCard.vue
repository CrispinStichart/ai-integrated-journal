<script setup lang="ts">
import type { ContributionResource } from '@journal/contracts';
import { computed, ref, watch } from 'vue';

import { recordingAudioUrl } from '../recording/api';
import type { LocalRecordingRecord } from '../storage/indexed-db';
import { displayCaptureTime } from '../journal/date';

const props = defineProps<{
  contribution?: ContributionResource | undefined;
  local?: LocalRecordingRecord | undefined;
  busy?: boolean | undefined;
}>();
const emit = defineEmits<{
  move: [journalDate: string];
  retry: [];
}>();

const recording = computed(() => props.contribution?.recording);
const recordingId = computed(
  () => props.local?.recordingId ?? recording.value?.id ?? '',
);
const capturedAt = computed(
  () => props.local?.capturedAt ?? props.contribution?.capturedAt ?? '',
);
const capturedTimezone = computed(
  () => props.local?.capturedTimezone ?? props.contribution?.capturedTimezone,
);
const journalDate = computed(
  () => props.local?.journalDate ?? props.contribution?.journalDate ?? '',
);
const assignedDate = ref(journalDate.value);
const persistenceState = computed(
  () =>
    props.local?.serverPersistenceState ?? recording.value?.persistenceState,
);
const isDurable = computed(() => persistenceState.value === 'durable');
const isFailed = computed(
  () =>
    props.local?.state === 'failed' ||
    props.local?.state === 'browser_storage_exhausted',
);
const canRetry = computed(
  () =>
    props.local?.retrySafe === true ||
    props.local?.state === 'browser_storage_exhausted' ||
    persistenceState.value === 'prepared',
);
const needsRetry = computed(
  () => isFailed.value || persistenceState.value === 'prepared',
);
const canMove = computed(
  () =>
    !props.busy &&
    props.local?.state !== 'recording' &&
    props.local?.state !== 'uploading',
);
const uploadProgress = computed(() => {
  const total = props.local?.nextChunkIndex ?? 0;
  if (total === 0) return 0;
  return Math.round(((props.local?.uploadedChunkCount ?? 0) / total) * 100);
});
const byteSize = computed(() => {
  const value = recording.value?.byteSize ?? props.local?.totalBytes;
  if (value === undefined) return undefined;
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return `${value} bytes`;
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
});

watch(journalDate, (value) => {
  assignedDate.value = value;
});
</script>

<template>
  <article
    class="card card-border bg-base-100 shadow-sm"
    :aria-label="`Audio recording captured ${capturedAt}`"
  >
    <div class="card-body gap-4 p-4 sm:p-5">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p class="font-semibold">Audio recording</p>
          <p class="text-xs text-base-content/60">
            Captured
            {{ displayCaptureTime(capturedAt, capturedTimezone ?? 'UTC') }} ·
            {{ capturedTimezone }}
            <template v-if="byteSize"> · {{ byteSize }}</template>
          </p>
        </div>
        <div class="flex flex-wrap justify-end gap-2" aria-label="Audio status">
          <span v-if="local?.state === 'recording'" class="badge badge-error"
            >Recording</span
          >
          <span
            v-else-if="local?.state === 'saved_locally'"
            class="badge badge-info"
            >Saved locally</span
          >
          <span
            v-else-if="local?.state === 'uploading'"
            class="badge badge-info"
            >Uploading</span
          >
          <span v-else-if="isFailed" class="badge badge-error">Failed</span>
          <template v-else-if="isDurable">
            <span class="badge badge-success">Durably saved</span>
            <span class="badge badge-ghost">Transcription pending</span>
          </template>
          <span v-else class="badge badge-info">Saved on server</span>
        </div>
      </div>

      <div v-if="local?.state === 'uploading'" role="status">
        <div class="mb-1 flex justify-between text-xs text-base-content/60">
          <span>Uploading saved checkpoints</span>
          <span>{{ uploadProgress }}%</span>
        </div>
        <progress class="progress w-full" :value="uploadProgress" max="100" />
      </div>

      <div v-if="needsRetry" role="alert" class="alert alert-error alert-soft">
        <span>
          {{
            local?.syncErrorMessage ??
            (persistenceState === 'prepared'
              ? 'Audio finalization was interrupted before durable confirmation.'
              : 'The saved recording needs attention before synchronization can continue.')
          }}
        </span>
        <button
          v-if="canRetry"
          class="btn btn-sm"
          type="button"
          :disabled="busy"
          @click="emit('retry')"
        >
          Retry safely
        </button>
      </div>

      <audio
        v-if="isDurable && !recording?.audioDeletedAt"
        class="w-full"
        controls
        preload="metadata"
        :src="recordingAudioUrl(recordingId)"
      >
        Your browser does not support audio playback.
      </audio>
      <p
        v-else-if="recording?.audioDeletedAt"
        class="text-sm text-base-content/70"
      >
        Original audio is recoverably deleted, so playback is unavailable.
      </p>
      <p
        v-else-if="!local && persistenceState !== 'durable'"
        class="text-sm text-base-content/70"
      >
        Upload recovery requires the device that holds the encrypted local
        checkpoints.
      </p>

      <form
        class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-end"
        aria-label="Assign audio to a different Journal Day"
        @submit.prevent="emit('move', assignedDate)"
      >
        <label class="fieldset sm:w-52">
          <span class="fieldset-legend">Assigned Journal Day</span>
          <input
            v-model="assignedDate"
            class="input w-full"
            type="date"
            required
          />
        </label>
        <button
          class="btn btn-sm"
          type="submit"
          :disabled="!canMove || assignedDate === journalDate"
        >
          Move recording
        </button>
      </form>
    </div>
  </article>
</template>
