<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useEventSource } from '@vueuse/core';
import type {
  NudgeActionRequest,
  NudgeDigestResource,
} from '@journal/contracts';
import { computed, reactive, ref, watch } from 'vue';

import { useAuthentication } from '../auth';
import { createUuidV7 } from '../journal/api';
import { actOnNudge, getNudgeDay } from '../nudge/api';
import { useUiStore } from '../stores/ui';

const props = defineProps<{ journalDate: string }>();
const emit = defineEmits<{ updated: [] }>();
const auth = useAuthentication();
const ui = useUiStore();
const queryClient = useQueryClient();
const answers = reactive<Record<string, string>>({});
const busy = ref(false);
const error = ref('');

const query = useQuery({
  queryKey: computed(() => ['nudges', props.journalDate]),
  queryFn: () => getNudgeDay(props.journalDate),
});
const eventData =
  typeof globalThis.EventSource === 'undefined'
    ? ref<string | null>(null)
    : useEventSource('/api/v1/events', [], {
        autoReconnect: { retries: 5, delay: 1_000 },
      }).data;
watch(eventData, (value) => {
  if (value === null) return;
  try {
    const event = JSON.parse(value) as {
      eventType?: string;
      payload?: { journalDate?: string };
    };
    if (
      event.eventType === 'nudge.updated' &&
      event.payload?.journalDate === props.journalDate
    )
      void query.refetch();
  } catch {
    // Unknown SSE data remains safely handled by the polling/query fallback.
  }
});

const evaluations = computed(() => query.data.value?.evaluations ?? []);
const digest = computed(() => query.data.value?.digest);
const failures = computed(() =>
  evaluations.value.filter((evaluation) => evaluation.state === 'failed'),
);
const pendingItems = computed(() =>
  (digest.value?.items ?? []).filter(
    (item) => item.state === 'pending_user_response',
  ),
);
const visible = computed(
  () =>
    evaluations.value.length > 0 ||
    query.isLoading.value ||
    query.isError.value,
);

function csrfToken(): string {
  const value = auth.status.value?.csrfToken;
  if (value === undefined)
    throw new Error('Your session needs to be refreshed.');
  return value;
}

function actionIdentity() {
  return {
    contributionId: createUuidV7(),
    revisionId: createUuidV7(),
    capturedAt: new Date().toISOString(),
    capturedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  } as const;
}

async function submit(action: NudgeActionRequest): Promise<void> {
  const current = digest.value;
  if (current === undefined) return;
  busy.value = true;
  error.value = '';
  try {
    const day = await actOnNudge({
      digestId: current.id,
      digestRevision: current.revision,
      action,
      csrfToken: csrfToken(),
      idempotencyKey: `nudge-${createUuidV7()}`,
    });
    queryClient.setQueryData(['nudges', props.journalDate], day);
    await queryClient.invalidateQueries({
      queryKey: ['journal-day', props.journalDate],
    });
    emit('updated');
    ui.announce('Required-information response saved to the Journal Day');
  } catch (caught) {
    error.value =
      caught instanceof Error
        ? caught.message
        : 'The response could not be saved.';
  } finally {
    busy.value = false;
  }
}

function answer(itemId: string): void {
  const text = answers[itemId]?.trim();
  if (!text) return;
  void submit({ action: 'answer', itemId, text, ...actionIdentity() });
}

function defer(): void {
  void submit({
    action: 'defer',
    deferredUntil: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    ...actionIdentity(),
  });
}

function dismiss(): void {
  void submit({ action: 'dismiss', ...actionIdentity() });
}

function notApplicable(itemId: string): void {
  void submit({ action: 'not_applicable', itemId, ...actionIdentity() });
}

function statusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

function digestTiming(value: NudgeDigestResource): string {
  if (value.status === 'queued')
    return `Queued until quiet hours end at ${new Date(value.scheduledAt).toLocaleString()}.`;
  if (value.status === 'deferred')
    return `Deferred until ${new Date(value.deferredUntil ?? value.scheduledAt).toLocaleString()}.`;
  return 'Your answers become durable contributions on this Journal Day.';
}
</script>

<template>
  <section
    v-if="visible"
    class="card card-border mt-7 bg-base-100"
    aria-labelledby="required-information-title"
  >
    <div class="card-body gap-4 p-4 sm:p-5">
      <div
        class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
      >
        <div>
          <h2 id="required-information-title" class="card-title">
            Required information
          </h2>
          <p class="mt-1 text-sm text-base-content/70">
            Requirement states are based on exact processor versions. Unknown,
            none, and not applicable remain distinct.
          </p>
        </div>
        <span v-if="digest" class="badge">{{
          statusLabel(digest.status)
        }}</span>
      </div>

      <div
        v-if="query.isLoading.value"
        role="status"
        class="flex items-center gap-2"
      >
        <span class="loading loading-spinner loading-sm" aria-hidden="true" />
        Checking requirements
      </div>
      <div
        v-else-if="query.isError.value"
        role="alert"
        class="alert alert-error alert-soft"
      >
        Requirement status could not be loaded.
      </div>

      <div
        v-for="failure in failures"
        :key="failure.id"
        role="status"
        class="alert alert-error alert-soft"
      >
        <div>
          <p class="font-semibold">
            {{ failure.processorName }} processing failed
          </p>
          <p class="text-sm">
            This is a technical processing failure, not missing journal
            information.
          </p>
        </div>
      </div>

      <div
        v-if="digest && ['queued', 'deferred'].includes(digest.status)"
        role="status"
        class="alert alert-info alert-soft"
      >
        {{ digestTiming(digest) }} Requirement state stays visible meanwhile.
      </div>

      <form
        v-for="item in pendingItems"
        :key="item.id"
        class="rounded-box border border-base-300 bg-base-200 p-4"
        @submit.prevent="answer(item.id)"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="font-semibold">{{ item.processorName }}</h3>
          <span class="badge badge-warning">needs information</span>
        </div>
        <p class="mt-2 text-sm">{{ item.prompt }}</p>
        <label class="fieldset mt-3">
          <span class="fieldset-legend">Your answer</span>
          <textarea
            v-model="answers[item.id]"
            class="textarea w-full"
            rows="3"
            :disabled="busy"
            :aria-label="`Answer ${item.processorName} requirement`"
          />
        </label>
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            class="btn btn-sm"
            type="submit"
            :disabled="busy || !answers[item.id]?.trim()"
          >
            Save answer
          </button>
          <button
            v-if="item.allowNotApplicable"
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="busy"
            @click="notApplicable(item.id)"
          >
            Not applicable
          </button>
        </div>
      </form>

      <div
        v-if="digest && pendingItems.length > 0"
        class="card-actions justify-end"
      >
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="busy"
          @click="defer"
        >
          Remind me in one hour
        </button>
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="busy"
          @click="dismiss"
        >
          Dismiss for this day
        </button>
      </div>

      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>

      <ul
        v-if="evaluations.length > 0"
        class="list"
        aria-label="Requirement states"
      >
        <li
          v-for="evaluation in evaluations"
          :key="evaluation.id"
          class="list-row px-0"
        >
          <div class="grow">
            <p class="font-medium">{{ evaluation.processorName }}</p>
            <p class="text-xs text-base-content/60">
              Processor version {{ evaluation.processorVersionId }}
            </p>
          </div>
          <span class="badge badge-outline">{{
            statusLabel(evaluation.state)
          }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>
