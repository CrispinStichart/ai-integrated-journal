<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  artifactEditRequestSchema,
  type ArtifactResource,
} from '@journal/contracts';
import { computed, ref } from 'vue';

import { useAuthentication } from '../auth';
import { createUuidV7 } from '../journal/api';
import {
  addArtifact,
  editArtifact,
  listArtifacts,
  mergeArtifacts,
} from '../artifact/api';
import AppDialog from './AppDialog.vue';
import FeedbackMemoryDialog from './FeedbackMemoryDialog.vue';

const props = defineProps<{ journalDayId: string }>();
const auth = useAuthentication();
const queryClient = useQueryClient();
const editor = ref<HTMLDialogElement & { open(): void; close(): void }>();
const confirmation = ref<HTMLDialogElement & { open(): void; close(): void }>();
const bulletEditor = ref<HTMLDialogElement & { open(): void; close(): void }>();
const selected = ref<string[]>([]);
const editing = ref<ArtifactResource>();
const jsonDraft = ref('');
const error = ref('');
const feedbackMessage = ref('');
const busy = ref(false);
const pendingAction = ref<'delete' | 'merge'>('delete');
const bulletDraft = ref('');
const bulletType = ref<'accomplishment' | 'notable_event'>('accomplishment');

const query = useQuery({
  queryKey: computed(() => ['artifacts', props.journalDayId]),
  queryFn: () => listArtifacts(props.journalDayId),
});
const active = computed(() =>
  (query.data.value ?? []).filter((item) => item.active),
);
const items = computed(() => query.data.value ?? []);

function isFoodArtifact(artifact: ArtifactResource): boolean {
  return artifact.provenance?.processorKey === 'food-and-drink';
}

function isMoodArtifact(artifact: ArtifactResource): boolean {
  return (
    artifact.provenance?.processorKey === 'mood' &&
    (artifact.payload.artifactType === 'mood_observation' ||
      artifact.payload.artifactType === 'daily_mood_aggregate')
  );
}

function isMoodAggregate(artifact: ArtifactResource): boolean {
  return artifact.payload.artifactType === 'daily_mood_aggregate';
}

function isSleepArtifact(artifact: ArtifactResource): boolean {
  return (
    artifact.provenance?.processorKey === 'sleep' &&
    (artifact.payload.periodType === 'nightly_sleep' ||
      artifact.payload.periodType === 'nap' ||
      artifact.payload.periodType === 'other_sleep_period')
  );
}

function isTaskArtifact(artifact: ArtifactResource): boolean {
  return (
    artifact.provenance?.processorKey === 'tasks-and-intentions' &&
    typeof artifact.payload.intentionClass === 'string'
  );
}

function isSummaryArtifact(artifact: ArtifactResource): boolean {
  return (
    artifact.provenance?.processorKey === 'summary' ||
    artifact.payload.artifactType === 'narrative_summary'
  );
}

function isAccomplishmentArtifact(artifact: ArtifactResource): boolean {
  return (
    artifact.provenance?.processorKey === 'accomplishments' ||
    artifact.payload.artifactType === 'accomplishment' ||
    artifact.payload.artifactType === 'notable_event'
  );
}

function textField(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function foodQuantity(artifact: ArtifactResource): string | undefined {
  const quantity = artifact.payload.quantity;
  if (
    quantity === null ||
    typeof quantity !== 'object' ||
    Array.isArray(quantity)
  )
    return undefined;
  const record = quantity as Readonly<Record<string, unknown>>;
  const quantityText =
    typeof record.text === 'string' ? record.text : undefined;
  const normalized = record.normalizedQuantity;
  if (
    normalized === null ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized)
  )
    return quantityText;
  const value = (normalized as Readonly<Record<string, unknown>>).value;
  const unit = (normalized as Readonly<Record<string, unknown>>).unit;
  return quantityText === undefined ||
    typeof value !== 'number' ||
    typeof unit !== 'string'
    ? quantityText
    : quantityText + ' (' + String(value) + ' ' + unit + ')';
}

function objectField(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = payload[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function humanizedField(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replaceAll('_', ' ') : undefined;
}

function sleepAssociation(artifact: ArtifactResource) {
  return objectField(artifact.payload, 'associatedDate');
}

function sleepResolutionBasis(artifact: ArtifactResource) {
  const association = sleepAssociation(artifact);
  return association === undefined
    ? undefined
    : objectField(association, 'resolutionBasis');
}

function sleepCandidateDates(artifact: ArtifactResource): readonly string[] {
  const candidates = sleepAssociation(artifact)?.candidateDates;
  return Array.isArray(candidates)
    ? candidates.filter((value): value is string => typeof value === 'string')
    : [];
}

function taskDueDate(artifact: ArtifactResource) {
  return objectField(artifact.payload, 'dueDate');
}

function taskDueDateBasis(artifact: ArtifactResource) {
  const dueDate = taskDueDate(artifact);
  return dueDate === undefined
    ? undefined
    : objectField(dueDate, 'resolutionBasis');
}

function taskDueDateCandidates(artifact: ArtifactResource): readonly string[] {
  const candidates = taskDueDate(artifact)?.candidateDates;
  return Array.isArray(candidates)
    ? candidates.filter((value): value is string => typeof value === 'string')
    : [];
}

function moodSemanticLabel(
  payload: Readonly<Record<string, unknown>>,
  key: 'rating' | 'valence',
): string {
  const semantic = objectField(payload, key);
  const state = semantic?.state;
  const value = semantic?.value;
  if (state === 'unknown') return 'Unknown';
  if (state === 'neutral') return 'Explicitly neutral';
  if (state === 'known' && typeof value === 'number')
    return `${String(value)} / 5`;
  if (state === 'known' && typeof value === 'string')
    return value.replaceAll('_', ' ');
  if (state === 'uncertain' && value !== undefined)
    return `Uncertain: ${String(value)}`;
  if (state === 'uncertain') return 'Uncertain';
  return 'Not recorded';
}

function artifactEvidence(artifact: ArtifactResource) {
  const ordinals = artifact.payload.evidenceOrdinals;
  if (!Array.isArray(ordinals)) return artifact.evidence;
  const selected = new Set(
    ordinals.filter((value): value is number => Number.isSafeInteger(value)),
  );
  return artifact.evidence.filter(({ ordinal }) => selected.has(ordinal));
}

function lineageLabel(value: Readonly<Record<string, unknown>> | undefined) {
  if (value === undefined) return undefined;
  const displayName = value.displayName;
  const id = value.id;
  return typeof displayName === 'string'
    ? displayName
    : typeof id === 'string'
      ? id
      : 'Recorded';
}

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

function openBulletEditor(): void {
  bulletDraft.value = '';
  bulletType.value = 'accomplishment';
  error.value = '';
  bulletEditor.value?.open();
}

async function saveBullet(): Promise<void> {
  const text = bulletDraft.value.trim();
  if (text.length === 0) {
    error.value = 'Enter a notable event or accomplishment.';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const identity = createUuidV7();
    await addArtifact({
      journalDayId: props.journalDayId,
      csrfToken: csrfToken(),
      idempotencyKey: createUuidV7(),
      artifact: {
        artifactId: identity,
        processorKey: 'accomplishments',
        logicalKey: `manual:accomplishment:${identity}`,
        kind: 'interpretation',
        payload: {
          bulletKey: `manual:${identity}`,
          artifactType: bulletType.value,
          text,
          completionBasis: 'user_authored',
          significanceBasis: 'user_authored',
          pinned: true,
          evidenceOrdinals: [],
        },
      },
    });
    bulletEditor.value?.close();
    await refresh();
  } catch (caught) {
    error.value =
      caught instanceof Error
        ? caught.message
        : 'The bullet could not be added.';
  } finally {
    busy.value = false;
  }
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
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-sm" type="button" @click="openBulletEditor">
          Add notable bullet
        </button>
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="selected.length < 2 || busy"
          @click="askMerge"
        >
          Merge selected
        </button>
      </div>
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
            <div
              v-if="isSummaryArtifact(artifact)"
              class="card card-border mt-3 bg-base-200"
            >
              <div class="card-body">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="card-title">Daily narrative summary</h3>
                  <span class="badge badge-outline">Interpretation</span>
                </div>
                <p class="leading-relaxed">
                  {{ textField(artifact.payload, 'narrative') }}
                </p>
                <p class="text-xs text-base-content/70">
                  Source-grounded narrative. Unknown values are excluded or
                  reported separately, never treated as neutral or zero.
                </p>
              </div>
            </div>
            <div
              v-else-if="isAccomplishmentArtifact(artifact)"
              class="card card-border mt-3 bg-base-200"
            >
              <div class="card-body">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="card-title">
                    {{ textField(artifact.payload, 'text') }}
                  </h3>
                  <span class="badge badge-outline">{{
                    artifact.payload.artifactType === 'accomplishment'
                      ? 'Accomplishment'
                      : 'Notable event'
                  }}</span>
                  <span
                    v-if="artifact.payload.pinned === true"
                    class="badge badge-ghost"
                    >Pinned manually</span
                  >
                </div>
                <p class="text-sm text-base-content/70">
                  This scan-friendly bullet is separate from the narrative
                  summary. Generated significance and completion require exact
                  source support.
                </p>
                <p
                  v-if="artifact.manualOperation === 'add'"
                  class="text-xs text-base-content/70"
                >
                  Added manually; no generated evidence span is claimed.
                </p>
              </div>
            </div>
            <div
              v-else-if="isFoodArtifact(artifact)"
              class="mt-3 rounded-box bg-base-200 p-4"
            >
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-lg font-semibold">
                  {{ textField(artifact.payload, 'description') }}
                </h3>
                <span class="badge">{{
                  textField(artifact.payload, 'classification')?.replaceAll(
                    '_',
                    ' ',
                  )
                }}</span>
                <span
                  v-if="
                    textField(artifact.payload, 'certainty') === 'uncertain'
                  "
                  class="badge badge-warning badge-soft"
                  >Uncertain</span
                >
              </div>
              <dl class="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                <div v-if="foodQuantity(artifact)">
                  <dt class="font-medium">Quantity</dt>
                  <dd>{{ foodQuantity(artifact) }}</dd>
                </div>
                <div v-if="textField(artifact.payload, 'meal')">
                  <dt class="font-medium">Meal</dt>
                  <dd>{{ textField(artifact.payload, 'meal') }}</dd>
                </div>
                <div v-if="textField(artifact.payload, 'timeOfDay')">
                  <dt class="font-medium">Time of day</dt>
                  <dd>{{ textField(artifact.payload, 'timeOfDay') }}</dd>
                </div>
                <div v-if="textField(artifact.payload, 'ownership')">
                  <dt class="font-medium">Consumption</dt>
                  <dd>
                    {{
                      textField(artifact.payload, 'ownership') === 'shared'
                        ? 'Shared by you'
                        : 'Consumed by you'
                    }}
                  </dd>
                </div>
              </dl>
              <p
                v-if="textField(artifact.payload, 'notes')"
                class="mt-3 text-sm text-base-content/70"
              >
                {{ textField(artifact.payload, 'notes') }}
              </p>
            </div>
            <div
              v-else-if="isMoodArtifact(artifact)"
              class="card card-border mt-3 bg-base-200"
            >
              <div class="card-body">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="card-title">
                    {{
                      isMoodAggregate(artifact)
                        ? 'Daily mood aggregate'
                        : textField(artifact.payload, 'characterization')
                    }}
                  </h3>
                  <span class="badge badge-outline">{{
                    isMoodAggregate(artifact)
                      ? 'Interpretation'
                      : 'Mood observation'
                  }}</span>
                  <span
                    v-if="
                      textField(artifact.payload, 'certainty') === 'uncertain'
                    "
                    class="badge badge-warning badge-soft"
                    >Uncertain</span
                  >
                </div>
                <div
                  v-if="
                    isMoodAggregate(artifact) &&
                    textField(artifact.payload, 'informationStatus') ===
                      'insufficient_information'
                  "
                  role="status"
                  class="alert alert-info alert-soft"
                >
                  <div>
                    <strong>Insufficient information</strong>
                    <p class="text-sm">
                      Mood was not established. This is unknown, not neutral,
                      and is excluded from numerical averages.
                    </p>
                  </div>
                </div>
                <dl
                  v-else
                  class="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2"
                >
                  <div v-if="isMoodAggregate(artifact)">
                    <dt class="font-medium">Overall rating</dt>
                    <dd>{{ moodSemanticLabel(artifact.payload, 'rating') }}</dd>
                  </div>
                  <div v-else>
                    <dt class="font-medium">Valence</dt>
                    <dd>
                      {{ moodSemanticLabel(artifact.payload, 'valence') }}
                    </dd>
                  </div>
                  <div v-if="textField(artifact.payload, 'timePeriod')">
                    <dt class="font-medium">Time period</dt>
                    <dd>{{ textField(artifact.payload, 'timePeriod') }}</dd>
                  </div>
                  <div v-if="textField(artifact.payload, 'context')">
                    <dt class="font-medium">Context</dt>
                    <dd>{{ textField(artifact.payload, 'context') }}</dd>
                  </div>
                </dl>
                <p
                  v-if="textField(artifact.payload, 'summary')"
                  class="text-sm"
                >
                  {{ textField(artifact.payload, 'summary') }}
                </p>
                <p
                  v-if="objectField(artifact.payload, 'derivation')?.ruleId"
                  class="text-xs text-base-content/70"
                >
                  Disclosed derivation rule:
                  {{ objectField(artifact.payload, 'derivation')?.ruleId }}
                </p>
                <p class="text-xs text-base-content/70">
                  Journaling analysis, not a clinical assessment.
                </p>
              </div>
            </div>
            <div
              v-else-if="isSleepArtifact(artifact)"
              class="card card-border mt-3 bg-base-200"
            >
              <div class="card-body">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="card-title">
                    {{
                      artifact.payload.periodType === 'nightly_sleep'
                        ? 'Nightly sleep'
                        : artifact.payload.periodType === 'nap'
                          ? 'Nap'
                          : 'Sleep period'
                    }}
                  </h3>
                  <span class="badge badge-outline">Sleep observation</span>
                  <span
                    v-if="sleepAssociation(artifact)?.state === 'uncertain'"
                    class="badge badge-warning badge-soft"
                    >Uncertain date</span
                  >
                  <span
                    v-if="sleepAssociation(artifact)?.manualOverride === true"
                    class="badge badge-ghost"
                    >Date corrected manually</span
                  >
                </div>
                <div
                  v-if="sleepAssociation(artifact)?.state === 'uncertain'"
                  role="status"
                  class="alert alert-warning alert-soft"
                >
                  <div>
                    <strong>Ambiguous sleep date</strong>
                    <p class="text-sm">
                      The original wording was not forced to a calendar date.
                      Review or correct this period.
                    </p>
                    <p
                      v-if="sleepCandidateDates(artifact).length > 0"
                      class="mt-1 text-sm"
                    >
                      Candidate dates:
                      {{ sleepCandidateDates(artifact).join(', ') }}
                    </p>
                  </div>
                </div>
                <p
                  v-if="artifact.payload.periodType === 'nightly_sleep'"
                  class="text-sm text-base-content/70"
                >
                  Nightly sleep is associated with the date you woke by default.
                  Use Correct below to change the date; manual corrections
                  remain authoritative.
                </p>
                <dl class="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <div v-if="sleepAssociation(artifact)?.resolvedDate">
                    <dt class="font-medium">Associated wake date</dt>
                    <dd>{{ sleepAssociation(artifact)?.resolvedDate }}</dd>
                  </div>
                  <div v-if="sleepAssociation(artifact)?.originalPhrase">
                    <dt class="font-medium">Original temporal phrase</dt>
                    <dd>“{{ sleepAssociation(artifact)?.originalPhrase }}”</dd>
                  </div>
                  <div v-if="textField(artifact.payload, 'reportedQuality')">
                    <dt class="font-medium">Reported quality</dt>
                    <dd>
                      {{ textField(artifact.payload, 'reportedQuality') }}
                    </dd>
                  </div>
                  <div v-if="textField(artifact.payload, 'reportedDuration')">
                    <dt class="font-medium">Reported duration</dt>
                    <dd>
                      {{ textField(artifact.payload, 'reportedDuration') }}
                    </dd>
                  </div>
                  <div v-if="textField(artifact.payload, 'reportedStart')">
                    <dt class="font-medium">Reported start</dt>
                    <dd>{{ textField(artifact.payload, 'reportedStart') }}</dd>
                  </div>
                  <div v-if="textField(artifact.payload, 'reportedEnd')">
                    <dt class="font-medium">Reported end</dt>
                    <dd>{{ textField(artifact.payload, 'reportedEnd') }}</dd>
                  </div>
                  <div v-if="textField(artifact.payload, 'interruptions')">
                    <dt class="font-medium">Interruptions</dt>
                    <dd>{{ textField(artifact.payload, 'interruptions') }}</dd>
                  </div>
                  <div v-if="textField(artifact.payload, 'context')">
                    <dt class="font-medium">Context</dt>
                    <dd>{{ textField(artifact.payload, 'context') }}</dd>
                  </div>
                </dl>
                <details class="collapse collapse-arrow bg-base-100">
                  <summary class="collapse-title text-sm font-medium">
                    Temporal resolution details
                  </summary>
                  <div class="collapse-content">
                    <dl class="space-y-1 text-xs">
                      <div>
                        <dt class="inline font-medium">Resolution rule:</dt>
                        <dd class="inline">
                          {{
                            humanizedField(
                              sleepResolutionBasis(artifact)?.ruleId,
                            ) ?? 'Unknown'
                          }}
                        </dd>
                      </div>
                      <div>
                        <dt class="inline font-medium">Timezone:</dt>
                        <dd class="inline">
                          {{
                            sleepAssociation(artifact)?.timezone ?? 'Unknown'
                          }}
                        </dd>
                      </div>
                      <div>
                        <dt class="inline font-medium">
                          Effective Journal Day:
                        </dt>
                        <dd class="inline">
                          {{
                            sleepResolutionBasis(artifact)
                              ?.effectiveJournalDate ?? 'Unknown'
                          }}
                        </dd>
                      </div>
                      <div>
                        <dt class="inline font-medium">Capture context:</dt>
                        <dd class="inline">
                          {{
                            sleepResolutionBasis(artifact)?.capturedAt ??
                            'Unknown'
                          }}
                          ·
                          {{
                            sleepResolutionBasis(artifact)?.capturedTimezone ??
                            'Unknown'
                          }}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </details>
              </div>
            </div>
            <div
              v-else-if="isTaskArtifact(artifact)"
              class="card card-border mt-3 bg-base-200"
            >
              <div class="card-body">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="card-title">
                    {{ textField(artifact.payload, 'description') }}
                  </h3>
                  <span class="badge badge-outline">{{
                    humanizedField(artifact.payload.intentionClass)
                  }}</span>
                  <span
                    v-if="artifact.payload.intentionClass === 'firm'"
                    class="badge badge-soft"
                    >Firm intention</span
                  >
                  <span
                    v-else-if="artifact.payload.intentionClass === 'tentative'"
                    class="badge badge-warning badge-soft"
                    >Tentative idea</span
                  >
                  <span
                    v-if="taskDueDate(artifact)?.state === 'unsupported'"
                    class="badge badge-warning badge-soft"
                    >Date unsupported</span
                  >
                  <span
                    v-else-if="taskDueDate(artifact)?.state === 'uncertain'"
                    class="badge badge-warning badge-soft"
                    >Date uncertain</span
                  >
                </div>
                <dl class="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt class="font-medium">Status</dt>
                    <dd>{{ humanizedField(artifact.payload.status) }}</dd>
                  </div>
                  <div>
                    <dt class="font-medium">Remember as</dt>
                    <dd>{{ humanizedField(artifact.payload.rememberKind) }}</dd>
                  </div>
                  <div v-if="textField(artifact.payload, 'suggestedBy')">
                    <dt class="font-medium">Suggested by</dt>
                    <dd>{{ textField(artifact.payload, 'suggestedBy') }}</dd>
                  </div>
                  <div v-if="taskDueDate(artifact)?.resolvedDate">
                    <dt class="font-medium">Supported due date</dt>
                    <dd>{{ taskDueDate(artifact)?.resolvedDate }}</dd>
                  </div>
                  <div v-if="taskDueDate(artifact)?.originalPhrase">
                    <dt class="font-medium">Original temporal phrase</dt>
                    <dd>“{{ taskDueDate(artifact)?.originalPhrase }}”</dd>
                  </div>
                </dl>
                <div
                  v-if="taskDueDate(artifact)?.state === 'unsupported'"
                  role="status"
                  class="alert alert-warning alert-soft"
                >
                  <div>
                    <strong>No supported due date</strong>
                    <p class="text-sm">
                      The temporal phrase is retained as evidence, but no date
                      was guessed. Correct it explicitly if needed.
                    </p>
                  </div>
                </div>
                <div
                  v-else-if="taskDueDate(artifact)?.state === 'uncertain'"
                  role="status"
                  class="alert alert-warning alert-soft"
                >
                  <div>
                    <strong>Ambiguous due date</strong>
                    <p class="text-sm">
                      The wording was not forced to one date.
                    </p>
                    <p
                      v-if="taskDueDateCandidates(artifact).length > 0"
                      class="mt-1 text-sm"
                    >
                      Candidate dates:
                      {{ taskDueDateCandidates(artifact).join(', ') }}
                    </p>
                  </div>
                </div>
                <p
                  v-else-if="!taskDueDate(artifact)"
                  class="text-sm text-base-content/70"
                >
                  No due date was supported by the source.
                </p>
                <div role="note" class="alert alert-info alert-soft">
                  <p class="text-sm">
                    Journal observation only. No external task was created;
                    explicit approval is required before external action.
                  </p>
                </div>
                <details
                  v-if="taskDueDate(artifact)"
                  class="collapse collapse-arrow bg-base-100"
                >
                  <summary class="collapse-title text-sm font-medium">
                    Due-date resolution details
                  </summary>
                  <div class="collapse-content">
                    <dl class="space-y-1 text-xs">
                      <div>
                        <dt class="inline font-medium">Resolution rule:</dt>
                        <dd class="inline">
                          {{
                            humanizedField(
                              taskDueDateBasis(artifact)?.ruleId,
                            ) ?? 'Unknown'
                          }}
                        </dd>
                      </div>
                      <div>
                        <dt class="inline font-medium">Timezone:</dt>
                        <dd class="inline">
                          {{ taskDueDate(artifact)?.timezone ?? 'Unknown' }}
                        </dd>
                      </div>
                      <div>
                        <dt class="inline font-medium">
                          Effective Journal Day:
                        </dt>
                        <dd class="inline">
                          {{
                            taskDueDateBasis(artifact)?.effectiveJournalDate ??
                            'Unknown'
                          }}
                        </dd>
                      </div>
                      <div>
                        <dt class="inline font-medium">Capture context:</dt>
                        <dd class="inline">
                          {{
                            taskDueDateBasis(artifact)?.capturedAt ?? 'Unknown'
                          }}
                          ·
                          {{
                            taskDueDateBasis(artifact)?.capturedTimezone ??
                            'Unknown'
                          }}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </details>
              </div>
            </div>
            <pre
              v-else
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
            <details
              v-if="artifact.evidence.length > 0 || artifact.provenance"
              class="collapse collapse-arrow mt-3 bg-base-200"
            >
              <summary class="collapse-title text-sm font-medium">
                Evidence and processing details
              </summary>
              <div class="collapse-content space-y-4">
                <ul
                  v-if="artifactEvidence(artifact).length > 0"
                  class="space-y-3"
                  aria-label="Supporting evidence"
                >
                  <li
                    v-for="evidence in artifactEvidence(artifact)"
                    :key="evidence.id"
                    class="rounded-box border border-base-300 bg-base-100 p-3"
                  >
                    <blockquote class="font-medium">
                      “{{ evidence.quote }}”
                    </blockquote>
                    <p class="mt-1 break-all text-xs text-base-content/70">
                      {{ evidence.sourceType.replaceAll('_', ' ') }} revision
                      {{ evidence.sourceRevisionId }} · UTF-16
                      {{ evidence.startUtf16 }}–{{ evidence.endUtf16 }} ·
                      {{ evidence.resolutionStatus }}
                    </p>
                    <p
                      v-if="evidence.audioRange"
                      class="mt-1 text-xs text-base-content/70"
                    >
                      Audio {{ evidence.audioRange.startMs }}–{{
                        evidence.audioRange.endMs
                      }}
                      ms
                    </p>
                  </li>
                </ul>
                <p v-else class="text-sm text-base-content/70">
                  No evidence spans are attached to this result.
                </p>
                <dl v-if="artifact.provenance" class="space-y-1 text-xs">
                  <div>
                    <dt class="inline font-medium">Processor:</dt>
                    <dd class="inline">
                      {{ artifact.provenance.processorName }} version
                      {{ artifact.provenance.semanticVersion }}
                    </dd>
                  </div>
                  <div>
                    <dt class="inline font-medium">Provider/model:</dt>
                    <dd class="inline">
                      {{
                        lineageLabel(artifact.provenance.provider) ?? 'Unknown'
                      }}
                      /
                      {{ lineageLabel(artifact.provenance.model) ?? 'Unknown' }}
                    </dd>
                  </div>
                  <div>
                    <dt class="inline font-medium">Processor version ID:</dt>
                    <dd class="inline break-all">
                      {{ artifact.provenance.processorVersionId }}
                    </dd>
                  </div>
                  <div>
                    <dt class="inline font-medium">Processing run ID:</dt>
                    <dd class="inline break-all">
                      {{ artifact.provenance.runId }}
                    </dd>
                  </div>
                  <div>
                    <dt class="inline font-medium">Instruction SHA-256:</dt>
                    <dd class="inline break-all">
                      {{ artifact.provenance.instructionHash }}
                    </dd>
                  </div>
                  <div>
                    <dt class="inline font-medium">Prompt template SHA-256:</dt>
                    <dd class="inline break-all">
                      {{ artifact.provenance.promptTemplateHash }}
                    </dd>
                  </div>
                  <div
                    v-if="
                      artifact.provenance.processingTimeMilliseconds !==
                      undefined
                    "
                  >
                    <dt class="inline font-medium">Processing time:</dt>
                    <dd class="inline">
                      {{ artifact.provenance.processingTimeMilliseconds }} ms
                    </dd>
                  </div>
                  <div v-if="artifact.provenance.completedAt">
                    <dt class="inline font-medium">Completed:</dt>
                    <dd class="inline">
                      <time :datetime="artifact.provenance.completedAt">
                        {{ artifact.provenance.completedAt }}
                      </time>
                    </dd>
                  </div>
                </dl>
              </div>
            </details>
            <div class="mt-3 flex flex-wrap gap-2">
              <button
                v-if="isAccomplishmentArtifact(artifact) && !artifact.deleted"
                class="btn btn-sm"
                type="button"
                :disabled="busy"
                @click="
                  perform(artifact, {
                    operation: 'pin',
                    pinned: artifact.payload.pinned !== true,
                  })
                "
              >
                {{ artifact.payload.pinned === true ? 'Unpin' : 'Pin' }}
              </button>
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
      id="artifact-bullet-add"
      ref="bulletEditor"
      title="Add notable bullet"
    >
      <label class="fieldset">
        <span class="fieldset-legend">Type</span>
        <select v-model="bulletType" class="select w-full">
          <option value="accomplishment">Accomplishment</option>
          <option value="notable_event">Notable event</option>
        </select>
      </label>
      <label class="fieldset mt-3">
        <span class="fieldset-legend">Bullet text</span>
        <textarea
          v-model="bulletDraft"
          class="textarea min-h-24 w-full"
          maxlength="500"
          placeholder="What do you want to remember?"
        />
      </label>
      <p class="mt-3 text-sm text-base-content/70">
        User-added bullets start pinned and remain authoritative during
        reprocessing. They do not claim generated evidence.
      </p>
      <template #actions>
        <button
          class="btn btn-ghost"
          type="button"
          @click="bulletEditor?.close()"
        >
          Cancel
        </button>
        <button class="btn" type="button" :disabled="busy" @click="saveBullet">
          Add bullet
        </button>
      </template>
    </AppDialog>
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
