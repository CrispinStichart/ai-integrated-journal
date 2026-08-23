<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type {
  TranscriptLayer,
  TranscriptLayerResource,
  TranscriptRevisionResource,
} from '@journal/contracts';
import { computed, reactive, ref, watch } from 'vue';

import { useAuthentication } from '../auth';
import { createUuidV7 } from '../journal/api';
import {
  editCorrectedTranscript,
  getRecordingTranscripts,
  listTranscriptRevisions,
  retryTranscriptCleanup,
} from '../transcript/api';

const props = defineProps<{ recordingId: string }>();
const emit = defineEmits<{
  seek: [startMilliseconds: number];
}>();

const auth = useAuthentication();
const queryClient = useQueryClient();
const selectedLayer = ref<TranscriptLayer>('raw_stt');
const editing = ref(false);
const draft = ref('');
const editReason = ref('');
const busy = ref(false);
const message = ref('');
const history = reactive<
  Partial<Record<TranscriptLayer, readonly TranscriptRevisionResource[]>>
>({});
const loadingHistory = ref<TranscriptLayer>();

const transcriptQuery = useQuery({
  queryKey: computed(() => ['recording-transcripts', props.recordingId]),
  queryFn: () => getRecordingTranscripts(props.recordingId),
  refetchInterval: (query) => {
    const data = query.state.data;
    return [data?.transcription?.status, data?.cleanup?.status].some((status) =>
      ['queued', 'running'].includes(status ?? ''),
    )
      ? 3_000
      : false;
  },
});

const inspector = computed(() => transcriptQuery.data.value);
const layers = computed(() => {
  const value = inspector.value;
  return [
    { key: 'raw_stt' as const, label: 'Raw STT', value: value?.rawStt },
    { key: 'corrected' as const, label: 'Corrected', value: value?.corrected },
    { key: 'cleaned' as const, label: 'Cleaned', value: value?.cleaned },
  ];
});
const activeLayer = computed(
  () => layers.value.find(({ key }) => key === selectedLayer.value)?.value,
);
const activeRevision = computed(() => activeLayer.value?.currentRevision);
const rawTimingUnavailable = computed(() => {
  const raw = inspector.value?.rawStt?.currentRevision;
  return (
    raw !== undefined &&
    (raw.segments.length === 0 ||
      raw.segments.every(({ timing }) => timing.status === 'unknown'))
  );
});

watch(
  () => inspector.value?.corrected?.currentRevision.id,
  () => {
    if (!editing.value)
      draft.value = inspector.value?.corrected?.currentRevision.text ?? '';
  },
  { immediate: true },
);

function csrfToken(): string {
  const token = auth.status.value?.csrfToken;
  if (token === undefined)
    throw new Error('Your session needs to be refreshed.');
  return token;
}

function layerDescription(layer: TranscriptLayer): string {
  if (layer === 'raw_stt')
    return 'Immutable provider capture. It is never changed by your edits.';
  if (layer === 'corrected')
    return 'Your factual correction of what was said. Edits apply only to this recording.';
  return 'A readable derived version with disfluencies removed. It may become stale after correction.';
}

function statusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

function statusClass(status: string): string {
  if (status === 'succeeded') return 'badge-success badge-soft';
  if (status === 'failed') return 'badge-error';
  if (status === 'stale') return 'badge-warning';
  if (status === 'running') return 'badge-info badge-soft';
  return 'badge-ghost';
}

function provenanceName(
  value: Readonly<Record<string, unknown>> | undefined,
): string {
  if (value === undefined) return 'Not reported';
  const parts = ['name', 'id', 'version']
    .map((key) => value[key])
    .filter((item): item is string => typeof item === 'string' && item !== '');
  return [...new Set(parts)].join(' · ') || 'Recorded metadata available';
}

function startEditing(): void {
  const corrected = inspector.value?.corrected;
  if (corrected === undefined) return;
  draft.value = corrected.currentRevision.text;
  editReason.value = '';
  message.value = '';
  editing.value = true;
}

async function saveCorrection(): Promise<void> {
  const corrected = inspector.value?.corrected;
  if (corrected === undefined || draft.value.trim() === '') return;
  busy.value = true;
  message.value = '';
  try {
    const updated = await editCorrectedTranscript({
      transcriptId: corrected.id,
      revision: corrected.currentRevision.revision,
      text: draft.value,
      ...(editReason.value.trim() === ''
        ? {}
        : { editReason: editReason.value.trim() }),
      csrfToken: csrfToken(),
      idempotencyKey: `transcript-edit-${createUuidV7()}`,
    });
    queryClient.setQueryData(
      ['recording-transcripts', props.recordingId],
      updated,
    );
    Reflect.deleteProperty(history, 'corrected');
    Reflect.deleteProperty(history, 'cleaned');
    editing.value = false;
    message.value =
      'Correction saved. Raw STT is unchanged; dependent cleanup is stale and replacement cleanup is queued.';
  } catch (error) {
    message.value =
      error instanceof Error
        ? error.message
        : 'The correction could not be saved.';
    await transcriptQuery.refetch();
  } finally {
    busy.value = false;
  }
}

async function retryCleanup(): Promise<void> {
  const corrected = inspector.value?.corrected;
  if (corrected === undefined) return;
  busy.value = true;
  message.value = '';
  try {
    const updated = await retryTranscriptCleanup({
      transcriptId: corrected.id,
      revision: corrected.currentRevision.revision,
      csrfToken: csrfToken(),
      idempotencyKey: `cleanup-retry-${createUuidV7()}`,
    });
    queryClient.setQueryData(
      ['recording-transcripts', props.recordingId],
      updated,
    );
    message.value = 'Cleanup retry queued.';
  } catch (error) {
    message.value =
      error instanceof Error ? error.message : 'Cleanup could not be retried.';
  } finally {
    busy.value = false;
  }
}

async function loadHistory(layer: TranscriptLayerResource): Promise<void> {
  if (history[layer.layer] !== undefined) return;
  loadingHistory.value = layer.layer;
  message.value = '';
  try {
    history[layer.layer] = await listTranscriptRevisions(layer.id);
  } catch (error) {
    message.value =
      error instanceof Error
        ? error.message
        : 'Revision history could not be loaded.';
  } finally {
    loadingHistory.value = undefined;
  }
}

function seek(
  revision: TranscriptRevisionResource,
  segmentIndex: number,
): void {
  const segment = revision.segments[segmentIndex];
  if (segment?.timing.status !== 'known') return;
  emit('seek', Number(segment.timing.startMilliseconds));
}

function formatMilliseconds(value: string): string {
  const totalSeconds = Math.floor(Number(value) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}
</script>

<template>
  <section
    class="border-t border-base-300 pt-4"
    aria-label="Transcript artifacts"
  >
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 class="font-semibold">Transcript artifacts</h3>
        <p class="text-xs text-base-content/60">
          Audio and each text layer remain separate and inspectable.
        </p>
      </div>
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        :disabled="transcriptQuery.isFetching.value"
        @click="transcriptQuery.refetch()"
      >
        <span
          v-if="transcriptQuery.isFetching.value"
          class="loading loading-spinner loading-xs"
          aria-hidden="true"
        />
        Refresh
      </button>
    </div>

    <div
      v-if="transcriptQuery.isPending.value"
      class="flex items-center gap-2 py-4 text-sm text-base-content/70"
      role="status"
    >
      <span class="loading loading-spinner loading-sm" aria-hidden="true" />
      Loading transcript artifacts
    </div>
    <div
      v-else-if="transcriptQuery.isError.value"
      class="alert alert-error alert-soft"
      role="alert"
    >
      <span
        >Transcript details could not be loaded. Original audio remains
        available.</span
      >
      <button
        class="btn btn-sm"
        type="button"
        @click="transcriptQuery.refetch()"
      >
        Try again
      </button>
    </div>

    <template v-else-if="inspector">
      <div
        class="mb-3 grid gap-2 sm:grid-cols-2"
        aria-label="Processing status"
      >
        <div class="rounded-box bg-base-200 p-3 text-sm">
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium">Transcription</span>
            <span
              v-if="inspector.transcription"
              class="badge badge-sm capitalize"
              :class="statusClass(inspector.transcription.status)"
            >
              {{ statusLabel(inspector.transcription.status) }}
            </span>
            <span v-else class="badge badge-sm badge-ghost">Not started</span>
          </div>
          <p
            v-if="inspector.transcription"
            class="mt-1 text-xs text-base-content/60"
          >
            Attempt {{ inspector.transcription.attempt }}
            <template v-if="inspector.transcription.errorCode">
              · {{ statusLabel(inspector.transcription.errorCode) }}
            </template>
          </p>
        </div>
        <div class="rounded-box bg-base-200 p-3 text-sm">
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium">Cleanup</span>
            <span
              v-if="inspector.cleanup"
              class="badge badge-sm capitalize"
              :class="statusClass(inspector.cleanup.status)"
            >
              {{ statusLabel(inspector.cleanup.status) }}
            </span>
            <span v-else class="badge badge-sm badge-ghost">Not started</span>
          </div>
          <div class="mt-1 flex items-center justify-between gap-2">
            <p v-if="inspector.cleanup" class="text-xs text-base-content/60">
              Attempt {{ inspector.cleanup.attempt }}
              <template v-if="inspector.cleanup.errorCode">
                · {{ statusLabel(inspector.cleanup.errorCode) }}
              </template>
            </p>
            <button
              v-if="inspector.cleanup?.retryable"
              class="btn btn-sm"
              type="button"
              :disabled="busy"
              @click="retryCleanup"
            >
              Retry cleanup
            </button>
          </div>
        </div>
      </div>

      <div
        v-if="message"
        class="alert alert-info alert-soft mb-3 text-sm"
        role="status"
        aria-live="polite"
      >
        <span>{{ message }}</span>
      </div>

      <details
        v-if="inspector.transcription?.status === 'succeeded'"
        class="collapse collapse-arrow mb-3 border border-base-300"
      >
        <summary class="collapse-title text-sm font-medium">
          Run provenance
        </summary>
        <div class="collapse-content space-y-2 text-sm">
          <p>
            <span class="font-medium">Transcription provider:</span>
            {{ provenanceName(inspector.transcription.provider) }}
          </p>
          <p>
            <span class="font-medium">Model:</span>
            {{ provenanceName(inspector.transcription.model) }}
          </p>
          <p v-if="inspector.transcription.processingTimeMilliseconds">
            <span class="font-medium">Processing time:</span>
            {{ inspector.transcription.processingTimeMilliseconds }} ms
          </p>
          <p v-if="inspector.cleanup?.prompt">
            <span class="font-medium">Cleanup instructions:</span>
            {{ inspector.cleanup.prompt.id }} version
            {{ inspector.cleanup.prompt.version }}
          </p>
          <details
            v-if="inspector.transcription.configuration"
            class="rounded-box bg-base-200 p-3"
          >
            <summary class="cursor-pointer font-medium">
              Configuration snapshot
            </summary>
            <pre class="mt-2 overflow-auto whitespace-pre-wrap text-xs">{{
              JSON.stringify(inspector.transcription.configuration, null, 2)
            }}</pre>
          </details>
          <details
            v-if="inspector.transcription.context?.length"
            class="rounded-box bg-base-200 p-3"
          >
            <summary class="cursor-pointer font-medium">
              Effective context
            </summary>
            <ul class="mt-2 space-y-2">
              <li
                v-for="(item, index) in inspector.transcription.context"
                :key="`${item.purpose}-${item.version ?? index}`"
              >
                <span class="font-medium">{{ item.purpose }}</span>
                <span v-if="item.version"> · version {{ item.version }}</span>
                <p class="whitespace-pre-wrap text-xs">{{ item.text }}</p>
              </li>
            </ul>
          </details>
        </div>
      </details>

      <div
        role="tablist"
        class="tabs tabs-border overflow-x-auto"
        aria-label="Transcript layers"
      >
        <button
          v-for="layer in layers"
          :key="layer.key"
          class="tab gap-2"
          :class="{ 'tab-active': selectedLayer === layer.key }"
          type="button"
          role="tab"
          :aria-selected="selectedLayer === layer.key"
          :disabled="layer.value === undefined"
          @click="selectedLayer = layer.key"
        >
          {{ layer.label }}
          <span
            v-if="layer.key === 'raw_stt'"
            class="badge badge-xs badge-ghost"
          >
            Immutable
          </span>
          <span
            v-if="layer.value?.currentRevision.staleAt"
            class="badge badge-xs badge-warning"
          >
            Stale
          </span>
        </button>
      </div>

      <div v-if="activeLayer && activeRevision" class="pt-4" role="tabpanel">
        <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <p class="text-sm text-base-content/70">
              {{ layerDescription(activeLayer.layer) }}
            </p>
            <p class="mt-1 text-xs text-base-content/60">
              Revision {{ activeRevision.revision }} ·
              {{
                activeRevision.authority === 'manual'
                  ? 'Human corrected'
                  : 'Generated'
              }}
            </p>
          </div>
          <button
            v-if="activeLayer.layer === 'corrected' && !editing"
            class="btn btn-sm"
            type="button"
            @click="startEditing"
          >
            Edit corrected transcript
          </button>
        </div>

        <div
          v-if="activeRevision.staleAt"
          class="alert alert-warning alert-soft mb-3 text-sm"
          role="status"
        >
          <span>
            This derived revision is stale because its exact corrected source
            changed.
          </span>
        </div>

        <form
          v-if="activeLayer.layer === 'corrected' && editing"
          class="space-y-3"
          aria-label="Edit corrected transcript"
          @submit.prevent="saveCorrection"
        >
          <label class="fieldset">
            <span class="fieldset-legend">Corrected transcript</span>
            <textarea
              v-model="draft"
              class="textarea min-h-48 w-full"
              required
            />
          </label>
          <label class="fieldset">
            <span class="fieldset-legend">Edit reason (optional)</span>
            <input
              v-model="editReason"
              class="input w-full"
              placeholder="What did you correct?"
            />
          </label>
          <p class="text-xs text-base-content/60">
            This corrects only this occurrence. It does not create a global
            rule.
          </p>
          <div class="flex justify-end gap-2">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="busy"
              @click="editing = false"
            >
              Cancel
            </button>
            <button
              class="btn btn-sm"
              type="submit"
              :disabled="busy || !draft.trim()"
            >
              <span
                v-if="busy"
                class="loading loading-spinner loading-xs"
                aria-hidden="true"
              />
              Save correction
            </button>
          </div>
        </form>
        <p
          v-else
          class="max-h-96 overflow-auto whitespace-pre-wrap rounded-box bg-base-200 p-4 text-sm leading-6"
        >
          {{ activeRevision.text }}
        </p>

        <section
          v-if="activeRevision.segments.length > 0"
          class="mt-4"
          aria-label="Evidence timing"
        >
          <h4 class="mb-2 text-sm font-semibold">Evidence segments</h4>
          <ul class="space-y-2">
            <li
              v-for="(segment, index) in activeRevision.segments"
              :key="segment.id"
              class="rounded-box border border-base-300 p-2"
            >
              <button
                v-if="
                  segment.timing.status === 'known' && inspector.audioAvailable
                "
                class="btn btn-ghost btn-sm h-auto min-h-10 w-full justify-start whitespace-normal text-left"
                type="button"
                :aria-label="`Play evidence at ${formatMilliseconds(segment.timing.startMilliseconds)}: ${segment.quote}`"
                @click="seek(activeRevision, index)"
              >
                <span class="badge badge-sm badge-ghost">
                  {{ formatMilliseconds(segment.timing.startMilliseconds) }}
                </span>
                <span>{{ segment.quote }}</span>
              </button>
              <div v-else class="flex gap-2 text-sm">
                <span class="badge badge-sm badge-ghost">No timing</span>
                <span>{{ segment.quote }}</span>
              </div>
            </li>
          </ul>
        </section>

        <div
          v-if="rawTimingUnavailable"
          class="alert alert-info alert-soft mt-4 text-sm"
          role="status"
        >
          <span>
            Timing unavailable. This transcript is valid, but its text cannot
            seek to an audio region.
          </span>
        </div>
        <div
          v-else-if="!inspector.audioAvailable"
          class="alert alert-warning alert-soft mt-4 text-sm"
          role="status"
        >
          <span>
            Audio playback is unavailable, so timed evidence cannot be played
            right now.
          </span>
        </div>

        <details class="collapse collapse-arrow mt-4 border border-base-300">
          <summary
            class="collapse-title font-medium"
            @click="loadHistory(activeLayer)"
          >
            Revision history ({{ activeLayer.revisionCount }})
          </summary>
          <div class="collapse-content">
            <div
              v-if="loadingHistory === activeLayer.layer"
              role="status"
              class="py-2"
            >
              <span
                class="loading loading-spinner loading-sm"
                aria-hidden="true"
              />
              <span class="sr-only">Loading revision history</span>
            </div>
            <ol v-else class="space-y-3">
              <li
                v-for="revision in history[activeLayer.layer] ?? []"
                :key="revision.id"
                class="rounded-box bg-base-200 p-3"
              >
                <div
                  class="flex flex-wrap items-center gap-2 text-xs text-base-content/60"
                >
                  <span class="font-medium text-base-content"
                    >Revision {{ revision.revision }}</span
                  >
                  <span>{{
                    revision.authority === 'manual'
                      ? 'Human corrected'
                      : 'Generated'
                  }}</span>
                  <span>{{
                    new Date(revision.createdAt).toLocaleString()
                  }}</span>
                  <span
                    v-if="revision.staleAt"
                    class="badge badge-warning badge-xs"
                    >Stale</span
                  >
                </div>
                <p v-if="revision.editReason" class="mt-1 text-xs">
                  Reason: {{ revision.editReason }}
                </p>
                <p
                  class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-sm"
                >
                  {{ revision.text }}
                </p>
              </li>
            </ol>
          </div>
        </details>
      </div>
      <div v-else class="alert alert-info alert-soft mt-4" role="status">
        <span>This transcript layer is not available yet.</span>
      </div>
    </template>
  </section>
</template>
