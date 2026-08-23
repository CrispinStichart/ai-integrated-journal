<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  artifactEditRequestSchema,
  type ArtifactResource,
} from '@journal/contracts';
import { computed, ref } from 'vue';

import { useAuthentication } from '../auth';
import { createUuidV7 } from '../journal/api';
import { editArtifact, listArtifacts, mergeArtifacts } from '../artifact/api';
import AppDialog from './AppDialog.vue';
import FeedbackMemoryDialog from './FeedbackMemoryDialog.vue';

const props = defineProps<{ journalDayId: string }>();
const auth = useAuthentication();
const queryClient = useQueryClient();
const editor = ref<HTMLDialogElement & { open(): void; close(): void }>();
const confirmation = ref<HTMLDialogElement & { open(): void; close(): void }>();
const selected = ref<string[]>([]);
const editing = ref<ArtifactResource>();
const jsonDraft = ref('');
const error = ref('');
const feedbackMessage = ref('');
const busy = ref(false);
const pendingAction = ref<'delete' | 'merge'>('delete');

const query = useQuery({
  queryKey: computed(() => ['artifacts', props.journalDayId]),
  queryFn: () => listArtifacts(props.journalDayId),
});
const active = computed(() =>
  (query.data.value ?? []).filter((item) => item.active),
);
const items = computed(() => query.data.value ?? []);

function csrfToken(): string {
  const token = auth.status.value?.csrfToken;
  if (token === undefined)
    throw new Error('Your session is no longer available.');
  return token;
}

async function refresh(): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: ['artifacts', props.journalDayId],
  });
}

function openEditor(artifact: ArtifactResource): void {
  editing.value = artifact;
  jsonDraft.value = JSON.stringify(artifact.payload, null, 2);
  error.value = '';
  editor.value?.open();
}

async function perform(
  artifact: ArtifactResource,
  edit: Parameters<typeof editArtifact>[0]['edit'],
): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await editArtifact({
      artifactId: artifact.id,
      revision: artifact.revision,
      csrfToken: csrfToken(),
      idempotencyKey: createUuidV7(),
      edit,
    });
    editor.value?.close();
    confirmation.value?.close();
    await refresh();
  } catch (caught) {
    error.value =
      caught instanceof Error
        ? caught.message
        : 'The artifact could not be changed.';
  } finally {
    busy.value = false;
  }
}

async function saveCorrection(): Promise<void> {
  if (editing.value === undefined) return;
  try {
    const payload: unknown = JSON.parse(jsonDraft.value);
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    )
      throw new Error('Artifact data must be a JSON object.');
    await perform(
      editing.value,
      artifactEditRequestSchema.parse({
        operation: 'correct',
        overrides: [{ path: '', value: payload }],
      }),
    );
  } catch (caught) {
    error.value =
      caught instanceof Error ? caught.message : 'Enter valid JSON.';
  }
}

function askDelete(artifact: ArtifactResource): void {
  editing.value = artifact;
  pendingAction.value = 'delete';
  confirmation.value?.open();
}

function askMerge(): void {
  if (selected.value.length < 2) return;
  pendingAction.value = 'merge';
  confirmation.value?.open();
}

async function confirmAction(): Promise<void> {
  if (pendingAction.value === 'delete' && editing.value !== undefined) {
    await perform(editing.value, { operation: 'delete' });
    return;
  }
  const sources = active.value.filter((item) =>
    selected.value.includes(item.id),
  );
  if (sources.length < 2) return;
  busy.value = true;
  try {
    await mergeArtifacts({
      csrfToken: csrfToken(),
      idempotencyKey: createUuidV7(),
      revisions: Object.fromEntries(
        sources.map((item) => [item.id, item.revision]),
      ),
      merge: {
        sourceArtifactIds: sources.map((item) => item.id),
        result: {
          artifactId: createUuidV7(),
          logicalKey: `manual:merge:${createUuidV7()}`,
          payload: { mergedItems: sources.map((item) => item.payload) },
        },
      },
    });
    selected.value = [];
    confirmation.value?.close();
    await refresh();
  } catch (caught) {
    error.value =
      caught instanceof Error
        ? caught.message
        : 'The artifacts could not be merged.';
  } finally {
    busy.value = false;
  }
}

async function split(artifact: ArtifactResource): Promise<void> {
  const entries = Object.entries(artifact.payload);
  if (entries.length < 2) {
    error.value =
      'This artifact needs at least two top-level fields to use the quick split.';
    return;
  }
  await perform(artifact, {
    operation: 'split',
    results: entries.map(([key, value]) => ({
      artifactId: createUuidV7(),
      logicalKey: `manual:split:${createUuidV7()}`,
      payload: { [key]: value },
    })),
  });
}
</script>

<template>
  <section class="mt-10" aria-labelledby="artifact-review-title">
    <div
      class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"
    >
      <div>
        <p class="text-xs font-semibold uppercase text-base-content/60">
          Derived results
        </p>
        <h2 id="artifact-review-title" class="text-2xl font-bold">
          Artifact review
        </h2>
        <p class="mt-1 max-w-2xl text-sm text-base-content/70">
          Corrections remain authoritative during reprocessing. New generated
          disagreements appear as candidates for your review.
        </p>
      </div>
      <button
        class="btn btn-sm"
        type="button"
        :disabled="selected.length < 2 || busy"
        @click="askMerge"
      >
        Merge selected
      </button>
    </div>

    <div v-if="error" role="alert" class="alert alert-error alert-soft mt-4">
      <span>{{ error }}</span
      ><button class="btn btn-ghost btn-sm" type="button" @click="error = ''">
        Dismiss
      </button>
    </div>
    <div
      v-if="feedbackMessage"
      role="status"
      class="alert alert-success alert-soft mt-4"
    >
      {{ feedbackMessage }}
    </div>
    <div
      v-if="query.isPending.value"
      class="mt-5 flex min-h-24 items-center justify-center"
      role="status"
    >
      <span class="loading loading-spinner" aria-hidden="true" /><span
        class="sr-only"
        >Loading artifacts</span
      >
    </div>
    <div
      v-else-if="query.isError.value"
      role="alert"
      class="alert alert-error mt-5"
    >
      <span>Could not load generated artifacts.</span
      ><button class="btn btn-sm" type="button" @click="query.refetch()">
        Try again
      </button>
    </div>
    <div v-else-if="items.length === 0" class="card card-border mt-5">
      <div class="card-body">
        <p class="text-base-content/70">
          No active processor artifacts for this day.
        </p>
      </div>
    </div>
    <ul v-else class="list mt-5 gap-3" aria-label="Processor artifacts">
      <li
        v-for="artifact in items"
        :key="artifact.id"
        class="list-row card card-border bg-base-100 p-4"
      >
        <label class="flex items-start gap-3"
          ><input
            v-model="selected"
            class="checkbox mt-1"
            type="checkbox"
            :value="artifact.id"
            :disabled="!artifact.active"
            :aria-label="`Select ${artifact.logicalKey} for merge`" /><span
            class="list-col-grow min-w-0"
          >
            <span class="flex flex-wrap items-center gap-2"
              ><strong class="break-all">{{ artifact.logicalKey }}</strong
              ><span class="badge badge-outline">{{
                artifact.authority === 'manual'
                  ? 'Manual authority'
                  : 'Generated'
              }}</span
              ><span
                v-if="artifact.manualOperation"
                class="badge badge-ghost"
                >{{ artifact.manualOperation.replace('_', ' ') }}</span
              ><span
                v-if="artifact.deleted"
                class="badge badge-error badge-soft"
                >Deleted</span
              ></span
            >
            <pre
              class="mt-3 max-h-48 overflow-auto rounded-box bg-base-200 p-3 text-xs whitespace-pre-wrap"
              >{{ JSON.stringify(artifact.payload, null, 2) }}</pre>
            <div
              v-if="artifact.generatedCandidate"
              role="status"
              class="alert alert-warning alert-soft mt-3"
            >
              <div>
                <strong>Generated candidate needs review</strong>
                <p class="mt-1 text-sm">Your manual value is still active.</p>
                <pre
                  class="mt-2 max-h-36 overflow-auto text-xs whitespace-pre-wrap"
                  >{{
                    JSON.stringify(artifact.generatedCandidate.payload, null, 2)
                  }}</pre>
                <div class="mt-3 flex flex-wrap gap-2">
                  <button
                    class="btn btn-sm"
                    type="button"
                    :disabled="busy"
                    @click="
                      perform(artifact, {
                        operation: 'adopt_candidate',
                        candidateId: artifact.generatedCandidate!.id,
                      })
                    "
                  >
                    Adopt as manual</button
                  ><button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    :disabled="busy"
                    @click="
                      perform(artifact, {
                        operation: 'dismiss_candidate',
                        candidateId: artifact.generatedCandidate!.id,
                      })
                    "
                  >
                    Dismiss suggestion
                  </button>
                </div>
              </div>
            </div>
            <details class="collapse collapse-arrow mt-3 bg-base-200">
              <summary class="collapse-title text-sm font-medium">
                Revision and provenance history
              </summary>
              <div class="collapse-content">
                <ol class="space-y-2 text-sm">
                  <li v-for="version in artifact.history" :key="version.id">
                    <span class="font-medium"
                      >{{ version.authority }} revision
                      {{ version.revision }}</span
                    >
                    · {{ version.lifecycle
                    }}<span v-if="version.processorVersionId">
                      · processor version {{ version.processorVersionId }}</span
                    ><span v-if="version.manualOperation">
                      · {{ version.manualOperation.replace('_', ' ') }}</span
                    >
                  </li>
                  <li
                    v-for="candidate in artifact.candidates"
                    :key="candidate.id"
                  >
                    <span class="font-medium">generated candidate</span> ·
                    {{ candidate.status }} · revision {{ candidate.versionId }}
                  </li>
                </ol>
              </div>
            </details>
            <div class="mt-3 flex flex-wrap gap-2">
              <button
                v-if="!artifact.deleted"
                class="btn btn-sm"
                type="button"
                :disabled="busy"
                @click="openEditor(artifact)"
              >
                Correct</button
              ><button
                v-if="!artifact.deleted"
                class="btn btn-ghost btn-sm"
                type="button"
                :disabled="busy"
                @click="perform(artifact, { operation: 'confirm' })"
              >
                Confirm</button
              ><button
                v-if="!artifact.deleted"
                class="btn btn-ghost btn-sm"
                type="button"
                :disabled="busy"
                @click="split(artifact)"
              >
                Split fields</button
              ><button
                v-if="artifact.authority === 'manual'"
                class="btn btn-ghost btn-sm"
                type="button"
                :disabled="busy"
                @click="perform(artifact, { operation: 'release_override' })"
              >
                Release override</button
              ><button
                v-if="!artifact.deleted"
                class="btn btn-error btn-soft btn-sm"
                type="button"
                :disabled="busy"
                @click="askDelete(artifact)"
              >
                Delete
              </button>
              <FeedbackMemoryDialog
                v-if="artifact.history[0]"
                :target="{
                  kind: 'artifact_version',
                  id: artifact.history[0].id,
                }"
                @saved="feedbackMessage = $event"
              />
            </div> </span
        ></label>
      </li>
    </ul>

    <AppDialog id="artifact-correction" ref="editor" title="Correct artifact"
      ><label class="fieldset"
        ><span class="fieldset-legend">Artifact JSON</span
        ><textarea
          v-model="jsonDraft"
          class="textarea min-h-64 w-full font-mono text-sm"
          spellcheck="false"
        />
      </label>
      <p class="mt-3 text-sm text-base-content/70">
        Saving creates an immutable manual revision. Generated values cannot
        replace it.
      </p>
      <template #actions
        ><button class="btn btn-ghost" type="button" @click="editor?.close()">
          Cancel</button
        ><button
          class="btn"
          type="button"
          :disabled="busy"
          @click="saveCorrection"
        >
          Save correction
        </button></template
      ></AppDialog
    >
    <AppDialog
      id="artifact-confirmation"
      ref="confirmation"
      :title="
        pendingAction === 'delete'
          ? 'Delete artifact?'
          : 'Merge selected artifacts?'
      "
      ><p>
        {{
          pendingAction === 'delete'
            ? 'This creates an authoritative manual tombstone. Reprocessing may suggest a candidate, but cannot restore the artifact without your approval.'
            : 'The selected artifacts will become authoritative tombstones and a new manual artifact will preserve their payloads.'
        }}
      </p>
      <template #actions
        ><button
          class="btn btn-ghost"
          type="button"
          @click="confirmation?.close()"
        >
          Cancel</button
        ><button
          :class="pendingAction === 'delete' ? 'btn btn-error' : 'btn'"
          type="button"
          :disabled="busy"
          @click="confirmAction"
        >
          {{
            pendingAction === 'delete' ? 'Delete artifact' : 'Merge artifacts'
          }}
        </button></template
      ></AppDialog
    >
  </section>
</template>
