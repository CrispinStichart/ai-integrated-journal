<script setup lang="ts">
import type {
  ContributionResource,
  PermanentDeletionPreview,
} from '@journal/contracts';
import { computed, ref, watch } from 'vue';

import { recordingAudioUrl, setRecordingAudioDeleted } from '../recording/api';
import {
  previewPermanentDeletion,
  requestPermanentDeletion,
} from '../retention/api';
import type { LocalRecordingRecord } from '../storage/indexed-db';
import { displayCaptureTime } from '../journal/date';
import TranscriptInspector from './TranscriptInspector.vue';
import AppDialog from './AppDialog.vue';

const props = defineProps<{
  contribution?: ContributionResource | undefined;
  local?: LocalRecordingRecord | undefined;
  busy?: boolean | undefined;
  csrfToken?: string;
}>();
const emit = defineEmits<{
  move: [journalDate: string];
  retry: [];
  retryTranscription: [];
  audioChanged: [];
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
const audioPlayer = ref<HTMLAudioElement>();
const deleteAudioDialog = ref<InstanceType<typeof AppDialog>>();
const permanentAudioDialog = ref<InstanceType<typeof AppDialog>>();
const permanentPreview = ref<PermanentDeletionPreview>();
const deletionError = ref('');
const deletionBusy = ref(false);
const persistenceState = computed(
  () =>
    props.local?.serverPersistenceState ?? recording.value?.persistenceState,
);
const isDurable = computed(() => persistenceState.value === 'durable');
const transcriptionState = computed(
  () => recording.value?.transcription?.state ?? 'queued',
);
const isTranscriptionFailed = computed(
  () => isDurable.value && transcriptionState.value === 'failed',
);
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

async function seekAudio(startMilliseconds: number): Promise<void> {
  const player = audioPlayer.value;
  if (player === undefined) return;
  player.currentTime = startMilliseconds / 1000;
  player.focus();
  await player.play().catch(() => undefined);
}

async function changeAudioDeletion(deleted: boolean): Promise<void> {
  if (props.csrfToken === undefined) return;
  deletionBusy.value = true;
  deletionError.value = '';
  try {
    await setRecordingAudioDeleted(recordingId.value, deleted, props.csrfToken);
    deleteAudioDialog.value?.close();
    emit('audioChanged');
  } catch (error) {
    deletionError.value =
      error instanceof Error ? error.message : 'Audio deletion failed.';
  } finally {
    deletionBusy.value = false;
  }
}

async function openPermanentAudioDeletion(): Promise<void> {
  if (props.csrfToken === undefined) return;
  deletionBusy.value = true;
  deletionError.value = '';
  permanentAudioDialog.value?.open();
  try {
    permanentPreview.value = await previewPermanentDeletion(
      { entityKind: 'recording_audio', entityId: recordingId.value },
      props.csrfToken,
    );
  } catch (error) {
    deletionError.value =
      error instanceof Error ? error.message : 'Deletion preview failed.';
  } finally {
    deletionBusy.value = false;
  }
}

async function permanentlyDeleteAudio(): Promise<void> {
  if (props.csrfToken === undefined || !permanentPreview.value?.eligible)
    return;
  deletionBusy.value = true;
  deletionError.value = '';
  try {
    await requestPermanentDeletion(
      { entityKind: 'recording_audio', entityId: recordingId.value },
      props.csrfToken,
    );
    permanentAudioDialog.value?.close();
    emit('audioChanged');
  } catch (error) {
    deletionError.value =
      error instanceof Error ? error.message : 'Audio deletion failed.';
  } finally {
    deletionBusy.value = false;
  }
}
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
            <span
              v-if="transcriptionState === 'succeeded'"
              class="badge badge-success badge-soft"
              >Transcribed</span
            >
            <span
              v-else-if="transcriptionState === 'running'"
              class="badge badge-info badge-soft"
              >Transcribing</span
            >
            <span v-else-if="isTranscriptionFailed" class="badge badge-error"
              >Transcription failed</span
            >
            <span v-else class="badge badge-ghost">Transcription pending</span>
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

      <div
        v-if="isTranscriptionFailed"
        role="alert"
        class="alert alert-error alert-soft sm:alert-horizontal"
      >
        <span>
          The transcription failed, but the original audio remains safely stored
          and playable.
        </span>
        <button
          class="btn btn-sm"
          type="button"
          :disabled="busy"
          @click="emit('retryTranscription')"
        >
          Retry transcription
        </button>
      </div>

      <audio
        v-if="isDurable && !recording?.audioDeletedAt"
        ref="audioPlayer"
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

      <TranscriptInspector
        v-if="isDurable && transcriptionState === 'succeeded'"
        :recording-id="recordingId"
        @seek="seekAudio"
      />

      <div
        v-if="isDurable && csrfToken"
        class="card-actions justify-end"
        aria-label="Audio retention actions"
      >
        <button
          v-if="!recording?.audioDeletedAt"
          class="btn btn-ghost btn-sm text-error"
          type="button"
          :disabled="busy || deletionBusy"
          @click="deleteAudioDialog?.open()"
        >
          Delete audio
        </button>
        <template v-else>
          <button
            class="btn btn-sm"
            type="button"
            :disabled="busy || deletionBusy"
            @click="changeAudioDeletion(false)"
          >
            Restore audio
          </button>
          <button
            class="btn btn-ghost btn-sm text-error"
            type="button"
            :disabled="busy || deletionBusy"
            @click="openPermanentAudioDeletion"
          >
            Delete audio permanently
          </button>
        </template>
      </div>

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

  <AppDialog
    :id="`delete-audio-${recordingId}`"
    ref="deleteAudioDialog"
    title="Delete the original audio?"
  >
    <div role="alert" class="alert alert-warning alert-soft">
      <span>
        The transcript remains available, but audio verification and timestamp
        playback stop immediately. Audio remains recoverable during the grace
        period.
      </span>
    </div>
    <div v-if="deletionError" role="alert" class="alert alert-error mt-3">
      <span>{{ deletionError }}</span>
    </div>
    <template #actions="{ close }">
      <button class="btn btn-ghost" type="button" @click="close">Cancel</button>
      <button
        class="btn btn-error"
        type="button"
        :disabled="deletionBusy"
        @click="changeAudioDeletion(true)"
      >
        Delete audio
      </button>
    </template>
  </AppDialog>

  <AppDialog
    :id="`permanent-delete-audio-${recordingId}`"
    ref="permanentAudioDialog"
    title="Permanently delete the original audio?"
  >
    <span
      v-if="deletionBusy && !permanentPreview"
      class="loading loading-spinner"
      role="status"
      aria-label="Loading audio deletion impact"
    />
    <div v-else-if="deletionError" role="alert" class="alert alert-error">
      <span>{{ deletionError }}</span>
    </div>
    <template v-else-if="permanentPreview">
      <div role="alert" class="alert alert-warning alert-soft">
        <span>
          The original blob and local recovery chunks are permanently removed.
          The transcript remains, but audio verification and timestamp playback
          can never be restored. Historical backups may retain encrypted bytes
          until expiry, and downloaded exports are outside system control.
        </span>
      </div>
      <p class="mt-4 text-sm">
        Eligible after
        {{ new Date(permanentPreview.eligibleAt).toLocaleString() }}.
      </p>
      <ul class="mt-3 list-disc space-y-1 pl-5 text-sm text-base-content/70">
        <li v-for="impact in permanentPreview.impacts" :key="impact.facet">
          {{ impact.detail }}
        </li>
      </ul>
    </template>
    <template #actions="{ close }">
      <button class="btn btn-ghost" type="button" @click="close">Cancel</button>
      <button
        class="btn btn-error"
        type="button"
        :disabled="deletionBusy || !permanentPreview?.eligible"
        @click="permanentlyDeleteAudio"
      >
        Permanently delete audio
      </button>
    </template>
  </AppDialog>
</template>
