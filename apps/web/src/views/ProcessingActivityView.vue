<script setup lang="ts">
import {
  reprocessingPreviewRequestSchema,
  type ReprocessingBatch,
  type ReprocessingPreviewRequest,
  type ReprocessingPreviewResponse,
} from '@journal/contracts';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, ref } from 'vue';

import { useAuthentication } from '../auth';
import AppDialog from '../components/AppDialog.vue';
import AppStatus from '../components/AppStatus.vue';
import { createUuidV7 } from '../journal/api';
import { listProcessors } from '../processor/api';
import {
  cancelReprocessing,
  listReprocessingBatches,
  previewReprocessing,
  startReprocessing,
} from '../reprocessing/api';

const today = new Date().toLocaleDateString('en-CA');
const auth = useAuthentication();
const queryClient = useQueryClient();
const processorsQuery = useQuery({
  queryKey: ['processors'],
  queryFn: listProcessors,
});
const historyQuery = useQuery({
  queryKey: ['reprocessing-batches'],
  queryFn: listReprocessingBatches,
  refetchInterval: 3_000,
});

const scope = ref<
  | 'contribution'
  | 'journal_day'
  | 'date_range'
  | 'processor'
  | 'processor_version'
>('journal_day');
const contributionId = ref('');
const journalDate = ref(today);
const startDate = ref(today);
const endDate = ref(today);
const processorId = ref('');
const processorVersionId = ref('');
const basisMode = ref<'current' | 'pinned'>('current');
const pinnedVersionId = ref('');
const preview = ref<ReprocessingPreviewResponse>();
const previewRequest = ref<ReprocessingPreviewRequest>();
const previewDialog = ref<InstanceType<typeof AppDialog>>();
const busy = ref(false);
const error = ref('');
const feedback = ref('');

const processors = computed(() => processorsQuery.data.value ?? []);
const versions = computed(() =>
  processors.value.flatMap((processor) =>
    processor.versions.map((version) => ({ processor, version })),
  ),
);
const batches = computed(() => historyQuery.data.value ?? []);

function csrfToken(): string {
  const value = auth.status.value?.csrfToken;
  if (value === undefined)
    throw new Error('Refresh your session before scheduling reprocessing.');
  return value;
}

function buildRequest(): ReprocessingPreviewRequest {
  const target =
    scope.value === 'contribution'
      ? { scope: scope.value, contributionId: contributionId.value }
      : scope.value === 'journal_day'
        ? { scope: scope.value, journalDate: journalDate.value }
        : scope.value === 'date_range'
          ? {
              scope: scope.value,
              startDate: startDate.value,
              endDate: endDate.value,
            }
          : scope.value === 'processor'
            ? {
                scope: scope.value,
                processorId: processorId.value,
                startDate: startDate.value,
                endDate: endDate.value,
              }
            : {
                scope: scope.value,
                processorVersionId: processorVersionId.value,
                startDate: startDate.value,
                endDate: endDate.value,
              };
  return reprocessingPreviewRequestSchema.parse({
    target,
    versionBasis:
      basisMode.value === 'current'
        ? { mode: 'current' }
        : { mode: 'pinned', processorVersionIds: [pinnedVersionId.value] },
  });
}

async function inspectImpact(): Promise<void> {
  busy.value = true;
  error.value = '';
  feedback.value = '';
  try {
    const request = buildRequest();
    previewRequest.value = request;
    preview.value = await previewReprocessing(request, csrfToken());
    previewDialog.value?.open();
  } catch (caught) {
    error.value =
      caught instanceof Error ? caught.message : 'Impact preview failed.';
  } finally {
    busy.value = false;
  }
}

async function confirmStart(): Promise<void> {
  const impact = preview.value;
  const request = previewRequest.value;
  if (impact === undefined || request === undefined) return;
  busy.value = true;
  error.value = '';
  try {
    const batch = await startReprocessing({
      preview: request,
      impactFingerprint: impact.impactFingerprint,
      csrfToken: csrfToken(),
      idempotencyKey: `reprocess-start-${createUuidV7()}`,
    });
    queryClient.setQueryData<readonly ReprocessingBatch[]>(
      ['reprocessing-batches'],
      (current = []) => [batch, ...current.filter(({ id }) => id !== batch.id)],
    );
    previewDialog.value?.close();
    feedback.value = `${batch.progress.total} exact-version processor runs were queued.`;
  } catch (caught) {
    error.value =
      caught instanceof Error
        ? caught.message
        : 'Reprocessing could not start.';
  } finally {
    busy.value = false;
  }
}

async function cancel(batch: ReprocessingBatch): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const updated = await cancelReprocessing({
      batch,
      csrfToken: csrfToken(),
      idempotencyKey: `reprocess-cancel-${createUuidV7()}`,
    });
    queryClient.setQueryData<readonly ReprocessingBatch[]>(
      ['reprocessing-batches'],
      (current = []) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
    );
    feedback.value =
      'Cancellation recorded. Completed results remain auditable.';
  } catch (caught) {
    error.value =
      caught instanceof Error ? caught.message : 'Cancellation failed.';
  } finally {
    busy.value = false;
  }
}

function scopeLabel(batch: ReprocessingBatch): string {
  switch (batch.target.scope) {
    case 'contribution':
      return `Contribution ${batch.target.contributionId}`;
    case 'journal_day':
      return `Journal Day ${batch.target.journalDate}`;
    case 'date_range':
      return `${batch.target.startDate} to ${batch.target.endDate}`;
    case 'processor':
      return `Processor over ${batch.target.startDate} to ${batch.target.endDate}`;
    case 'processor_version':
      return `Processor version over ${batch.target.startDate} to ${batch.target.endDate}`;
  }
}

function statusTone(
  status: ReprocessingBatch['status'],
): 'error' | 'info' | 'neutral' | 'success' | 'warning' {
  if (status === 'completed') return 'success';
  if (status === 'completed_with_failures') return 'error';
  if (status === 'canceled') return 'warning';
  return 'info';
}

function canCancel(batch: ReprocessingBatch): boolean {
  return batch.status === 'queued' || batch.status === 'running';
}
</script>

<template>
  <section class="space-y-8" aria-labelledby="activity-title">
    <header>
      <p class="text-sm font-semibold text-base-content/60">Processing</p>
      <h1 id="activity-title" class="text-3xl font-bold tracking-tight">
        Reprocessing activity
      </h1>
      <p class="mt-2 max-w-3xl text-base-content/70">
        Preview historical impact, pin the processor semantics, then monitor or
        cancel the resulting work. Reprocessing creates new immutable runs and
        never replaces manual authority.
      </p>
    </header>

    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
    <div v-if="feedback" class="alert alert-success" role="status">
      {{ feedback }}
    </div>

    <form class="card card-border bg-base-200" @submit.prevent="inspectImpact">
      <div class="card-body">
        <h2 class="card-title">Plan reprocessing</h2>
        <p class="text-sm text-base-content/70">
          Date ranges are limited to 366 days and confirmed batches to 10,000
          runs. Previewing does not call a provider or change journal data.
        </p>
        <div class="grid gap-4 md:grid-cols-2">
          <fieldset class="fieldset">
            <legend class="fieldset-legend">
              <label for="reprocessing-scope">Scope</label>
            </legend>
            <select
              id="reprocessing-scope"
              v-model="scope"
              class="select w-full"
            >
              <option value="contribution">Contribution</option>
              <option value="journal_day">Journal Day</option>
              <option value="date_range">Date range</option>
              <option value="processor">Processor</option>
              <option value="processor_version">Processor version</option>
            </select>
          </fieldset>

          <fieldset v-if="scope === 'contribution'" class="fieldset">
            <legend class="fieldset-legend">
              <label for="reprocessing-contribution">Contribution ID</label>
            </legend>
            <input
              id="reprocessing-contribution"
              v-model="contributionId"
              class="input w-full"
              required
              autocomplete="off"
            />
          </fieldset>
          <fieldset v-if="scope === 'journal_day'" class="fieldset">
            <legend class="fieldset-legend">
              <label for="reprocessing-day">Journal date</label>
            </legend>
            <input
              id="reprocessing-day"
              v-model="journalDate"
              class="input w-full"
              type="date"
              required
            />
          </fieldset>
          <template
            v-if="
              scope === 'date_range' ||
              scope === 'processor' ||
              scope === 'processor_version'
            "
          >
            <fieldset class="fieldset">
              <legend class="fieldset-legend">
                <label for="reprocessing-start">Start date</label>
              </legend>
              <input
                id="reprocessing-start"
                v-model="startDate"
                class="input w-full"
                type="date"
                required
              />
            </fieldset>
            <fieldset class="fieldset">
              <legend class="fieldset-legend">
                <label for="reprocessing-end">End date</label>
              </legend>
              <input
                id="reprocessing-end"
                v-model="endDate"
                class="input w-full"
                type="date"
                required
              />
            </fieldset>
          </template>
          <fieldset v-if="scope === 'processor'" class="fieldset">
            <legend class="fieldset-legend">
              <label for="reprocessing-processor">Processor</label>
            </legend>
            <select
              id="reprocessing-processor"
              v-model="processorId"
              class="select w-full"
              required
            >
              <option value="" disabled>Select a processor</option>
              <option
                v-for="processor in processors"
                :key="processor.id"
                :value="processor.id"
              >
                {{ processor.name }}
              </option>
            </select>
          </fieldset>
          <fieldset v-if="scope === 'processor_version'" class="fieldset">
            <legend class="fieldset-legend">
              <label for="reprocessing-version">Processor version</label>
            </legend>
            <select
              id="reprocessing-version"
              v-model="processorVersionId"
              class="select w-full"
              required
            >
              <option value="" disabled>Select an immutable version</option>
              <option
                v-for="item in versions"
                :key="item.version.id"
                :value="item.version.id"
              >
                {{ item.processor.name }} v{{
                  item.version.definition.semanticVersion
                }}
              </option>
            </select>
          </fieldset>

          <fieldset class="fieldset">
            <legend class="fieldset-legend">
              <label for="reprocessing-basis">Version basis</label>
            </legend>
            <select
              id="reprocessing-basis"
              v-model="basisMode"
              class="select w-full"
            >
              <option value="current">Current enabled versions</option>
              <option value="pinned">One pinned immutable version</option>
            </select>
            <p class="label">
              The preview always records resolved immutable version IDs.
            </p>
          </fieldset>
          <fieldset v-if="basisMode === 'pinned'" class="fieldset">
            <legend class="fieldset-legend">
              <label for="reprocessing-pinned-version">Pinned version</label>
            </legend>
            <select
              id="reprocessing-pinned-version"
              v-model="pinnedVersionId"
              class="select w-full"
              required
            >
              <option value="" disabled>Select an immutable version</option>
              <option
                v-for="item in versions"
                :key="item.version.id"
                :value="item.version.id"
              >
                {{ item.processor.name }} v{{
                  item.version.definition.semanticVersion
                }}
              </option>
            </select>
          </fieldset>
        </div>
        <div class="card-actions justify-end">
          <button class="btn btn-primary" type="submit" :disabled="busy">
            Preview impact
          </button>
        </div>
      </div>
    </form>

    <section aria-labelledby="history-title">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="history-title" class="text-2xl font-bold">Audit history</h2>
          <p class="text-sm text-base-content/70">
            Progress refreshes every three seconds when this page is open.
          </p>
        </div>
        <button
          class="btn btn-sm"
          type="button"
          :disabled="historyQuery.isFetching.value"
          @click="historyQuery.refetch()"
        >
          Refresh
        </button>
      </div>
      <div v-if="batches.length === 0" class="alert">
        No reprocessing batches have been confirmed.
      </div>
      <div v-else class="space-y-4">
        <article
          v-for="batch in batches"
          :key="batch.id"
          class="card card-border bg-base-100"
        >
          <div class="card-body">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 class="card-title text-base">{{ scopeLabel(batch) }}</h3>
                <p class="text-xs text-base-content/60">
                  {{ new Date(batch.createdAt).toLocaleString() }} · batch
                  {{ batch.id }}
                </p>
              </div>
              <AppStatus
                :label="batch.status.replaceAll('_', ' ')"
                :detail="`${batch.progress.percent}% complete`"
                :tone="statusTone(batch.status)"
              />
            </div>
            <progress
              class="progress"
              :value="batch.progress.percent"
              max="100"
              :aria-label="`${batch.progress.percent}% complete`"
            />
            <p class="text-sm">
              {{ batch.progress.percent }}% complete ·
              {{ batch.progress.succeeded }} succeeded,
              {{ batch.progress.failed }} failed,
              {{ batch.progress.canceled }} canceled,
              {{ batch.progress.queued + batch.progress.running }} remaining.
            </p>
            <div class="overflow-x-auto">
              <table class="table table-sm">
                <caption class="sr-only">
                  Exact processor-version basis
                </caption>
                <thead>
                  <tr>
                    <th>Processor</th>
                    <th>Version</th>
                    <th>Input scope</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="version in batch.versionBasis.versions"
                    :key="version.processorVersionId"
                  >
                    <td>{{ version.processorName }}</td>
                    <td>
                      v{{ version.semanticVersion }}
                      <span
                        class="block font-mono text-xs text-base-content/60"
                      >
                        {{ version.processorVersionId }}
                      </span>
                    </td>
                    <td>{{ version.inputScope.replace('_', ' ') }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-actions justify-end">
              <button
                v-if="canCancel(batch)"
                class="btn btn-error btn-outline"
                type="button"
                :disabled="busy"
                @click="cancel(batch)"
              >
                Cancel remaining work
              </button>
            </div>
          </div>
        </article>
      </div>
    </section>

    <AppDialog
      id="reprocessing-preview"
      ref="previewDialog"
      title="Confirm reprocessing impact"
    >
      <div v-if="preview" class="space-y-4">
        <div
          class="stats stats-vertical w-full bg-base-200 sm:stats-horizontal"
        >
          <div class="stat">
            <div class="stat-title">Processor runs</div>
            <div class="stat-value text-2xl">{{ preview.impact.runCount }}</div>
          </div>
          <div class="stat">
            <div class="stat-title">Approx. provider operations</div>
            <div class="stat-value text-2xl">
              {{ preview.impact.approximateProviderOperationCount }}
            </div>
          </div>
          <div class="stat">
            <div class="stat-title">Manual overrides protected</div>
            <div class="stat-value text-2xl">
              {{ preview.impact.manualOverrideCount }}
            </div>
          </div>
        </div>
        <p>
          Affects {{ preview.impact.journalDayCount }} Journal Day(s) and
          {{ preview.impact.contributionCount }} contribution(s), including
          {{ preview.impact.staleArtifactCount }} stale result(s).
        </p>
        <div
          v-for="warning in preview.warnings"
          :key="warning"
          class="alert alert-warning"
        >
          {{ warning }}
        </div>
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <caption class="text-left font-semibold">
              Immutable version basis
            </caption>
            <thead>
              <tr>
                <th>Processor</th>
                <th>Version</th>
                <th>Runs use</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="version in preview.versionBasis.versions"
                :key="version.processorVersionId"
              >
                <td>{{ version.processorName }}</td>
                <td>v{{ version.semanticVersion }}</td>
                <td class="font-mono text-xs">
                  {{ version.processorVersionId }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-sm text-base-content/70">
          Confirmation schedules new runs against these exact immutable
          versions. Historical results remain in audit history, and active
          manual values continue to win during reconciliation.
        </p>
      </div>
      <template #actions="{ close }">
        <button class="btn" type="button" :disabled="busy" @click="close">
          Go back
        </button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="busy"
          @click="confirmStart"
        >
          Confirm and start
        </button>
      </template>
    </AppDialog>
  </section>
</template>
