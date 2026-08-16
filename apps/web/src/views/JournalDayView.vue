<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type {
  ContributionResource,
  ContributionRevisionResource,
} from '@journal/contracts';
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import ContributionCard from '../components/ContributionCard.vue';
import { useAuthentication } from '../auth';
import {
  createContribution,
  createUuidV7,
  editContribution,
  getContribution,
  getJournalDay,
  JournalApiError,
  listContributionRevisions,
  setContributionDeleted,
} from '../journal/api';
import {
  displayJournalDate,
  localJournalDate,
  shiftJournalDate,
} from '../journal/date';
import { useUiStore } from '../stores/ui';

const props = defineProps<{ date?: string }>();
const journalDate = computed(() => props.date ?? localJournalDate());
const router = useRouter();
const queryClient = useQueryClient();
const auth = useAuthentication();
const ui = useUiStore();
const newText = ref('');
const selectedDate = ref(journalDate.value);
const submitting = ref(false);
const errorMessage = ref('');
const revisions = reactive<
  Record<string, readonly ContributionRevisionResource[]>
>({});
const conflict = ref<{
  current: ContributionResource;
  draft: string;
  reason: string;
}>();

const dayQuery = useQuery({
  queryKey: computed(() => ['journal-day', journalDate.value]),
  queryFn: () => getJournalDay(journalDate.value),
});
const contributions = computed(() => dayQuery.data.value?.contributions ?? []);
const activeCount = computed(
  () =>
    contributions.value.filter((item) => item.deletedAt === undefined).length,
);
const dayTitle = computed(() =>
  props.date === undefined ? 'Today' : displayJournalDate(journalDate.value),
);

watch(journalDate, (value) => {
  selectedDate.value = value;
  errorMessage.value = '';
  conflict.value = undefined;
});

function csrfToken(): string {
  const token = auth.status.value?.csrfToken;
  if (token === undefined)
    throw new Error('Your session needs to be refreshed.');
  return token;
}

async function refresh(): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: ['journal-day', journalDate.value],
    }),
    queryClient.invalidateQueries({ queryKey: ['journal-days'] }),
  ]);
}

function showError(error: unknown): void {
  errorMessage.value =
    error instanceof Error
      ? error.message
      : 'The journal could not be updated.';
}

async function addContribution(): Promise<void> {
  const text = newText.value.trim();
  if (text === '') return;
  submitting.value = true;
  errorMessage.value = '';
  try {
    const capturedAt = new Date().toISOString();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await createContribution(
      {
        contributionId: createUuidV7(),
        revisionId: createUuidV7(),
        proposedJournalDayId: createUuidV7(),
        sourceType: 'typed_text',
        text,
        capturedAt,
        capturedTimezone: timezone,
        journalTimezone: timezone,
        journalDate: journalDate.value,
        journalDateAssignment:
          journalDate.value === localJournalDate()
            ? 'default'
            : 'user_override',
      },
      csrfToken(),
      `create-${createUuidV7()}`,
    );
    newText.value = '';
    ui.announce('Contribution added');
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    submitting.value = false;
  }
}

async function saveEdit(
  contribution: ContributionResource,
  text: string,
  reason: string,
): Promise<void> {
  submitting.value = true;
  errorMessage.value = '';
  conflict.value = undefined;
  try {
    await editContribution(
      contribution,
      text,
      reason,
      createUuidV7(),
      csrfToken(),
      `edit-${createUuidV7()}`,
    );
    ui.announce('A new contribution revision was saved');
    await refresh();
  } catch (error) {
    if (error instanceof JournalApiError && error.code === 'etag_mismatch') {
      try {
        conflict.value = {
          current: await getContribution(contribution.id),
          draft: text,
          reason,
        };
      } catch (refreshError) {
        showError(refreshError);
      }
    } else {
      showError(error);
    }
  } finally {
    submitting.value = false;
  }
}

async function retryConflict(): Promise<void> {
  const value = conflict.value;
  if (value === undefined) return;
  await saveEdit(value.current, value.draft, value.reason);
}

async function changeDeletion(
  contribution: ContributionResource,
  deleted: boolean,
): Promise<void> {
  submitting.value = true;
  errorMessage.value = '';
  try {
    await setContributionDeleted(
      contribution,
      deleted,
      csrfToken(),
      `${deleted ? 'delete' : 'restore'}-${createUuidV7()}`,
    );
    ui.announce(deleted ? 'Contribution deleted' : 'Contribution restored');
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    submitting.value = false;
  }
}

async function loadHistory(contribution: ContributionResource): Promise<void> {
  if (revisions[contribution.id] !== undefined) return;
  try {
    revisions[contribution.id] = await listContributionRevisions(
      contribution.id,
    );
  } catch (error) {
    showError(error);
  }
}

async function selectDate(): Promise<void> {
  await router.push(`/journal/${selectedDate.value}`);
}
</script>

<template>
  <section :aria-labelledby="`journal-day-${journalDate}`">
    <div
      class="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"
    >
      <div>
        <p class="mb-2 text-sm font-medium text-base-content/60">Journal Day</p>
        <h1
          :id="`journal-day-${journalDate}`"
          class="text-3xl font-bold tracking-tight sm:text-4xl"
        >
          {{ dayTitle }}
        </h1>
        <p v-if="date === undefined" class="mt-1 text-base-content/70">
          {{ displayJournalDate(journalDate) }}
        </p>
        <p class="mt-2 text-sm text-base-content/60">
          {{ activeCount }} active
          {{ activeCount === 1 ? 'contribution' : 'contributions' }}
        </p>
      </div>

      <form
        class="flex items-end gap-2"
        aria-label="Choose a Journal Day"
        @submit.prevent="selectDate"
      >
        <label class="fieldset grow sm:grow-0">
          <span class="fieldset-legend">Go to date</span>
          <input
            v-model="selectedDate"
            type="date"
            class="input w-full"
            required
          />
        </label>
        <button class="btn" type="submit">Go</button>
      </form>
    </div>

    <nav
      class="mt-5 flex items-center justify-between"
      aria-label="Adjacent Journal Days"
    >
      <RouterLink
        class="btn btn-ghost btn-sm"
        :to="`/journal/${shiftJournalDate(journalDate, -1)}`"
      >
        ← Previous day
      </RouterLink>
      <RouterLink class="btn btn-ghost btn-sm" to="/">Today</RouterLink>
      <RouterLink
        class="btn btn-ghost btn-sm"
        :to="`/journal/${shiftJournalDate(journalDate, 1)}`"
      >
        Next day →
      </RouterLink>
    </nav>

    <div
      v-if="errorMessage"
      role="alert"
      class="alert alert-error alert-soft mt-5"
    >
      <span>{{ errorMessage }}</span>
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        @click="errorMessage = ''"
      >
        Dismiss
      </button>
    </div>

    <div
      v-if="conflict"
      role="alert"
      class="alert alert-warning alert-soft mt-5 items-start"
    >
      <div>
        <h2 class="font-semibold">This contribution changed elsewhere</h2>
        <p class="mt-1 text-sm">
          Your draft was not overwritten. Review the latest saved text below,
          then retry only if your draft should become the newest revision.
        </p>
        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <div class="rounded-box bg-base-100 p-3">
            <p class="text-xs font-semibold uppercase text-base-content/60">
              Latest saved text
            </p>
            <p class="mt-1 whitespace-pre-wrap">
              {{ conflict.current.currentRevision?.text }}
            </p>
          </div>
          <div class="rounded-box bg-base-100 p-3">
            <p class="text-xs font-semibold uppercase text-base-content/60">
              Your draft
            </p>
            <p class="mt-1 whitespace-pre-wrap">{{ conflict.draft }}</p>
          </div>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            class="btn btn-sm"
            type="button"
            :disabled="submitting"
            @click="retryConflict"
          >
            Save draft as new revision
          </button>
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            @click="conflict = undefined"
          >
            Keep latest saved version
          </button>
        </div>
      </div>
    </div>

    <form
      class="card card-border mt-7 bg-base-200"
      aria-label="Add a typed contribution"
      @submit.prevent="addContribution"
    >
      <div class="card-body gap-3 p-4 sm:p-5">
        <label class="fieldset">
          <span class="fieldset-legend">Add to this day</span>
          <textarea
            v-model="newText"
            class="textarea min-h-32 w-full bg-base-100"
            placeholder="What would you like to remember?"
            required
          />
        </label>
        <div class="card-actions justify-end">
          <button
            class="btn btn-primary"
            type="submit"
            :disabled="submitting || !newText.trim()"
          >
            <span
              v-if="submitting"
              class="loading loading-spinner loading-sm"
              aria-hidden="true"
            />
            Add contribution
          </button>
        </div>
      </div>
    </form>

    <div
      v-if="dayQuery.isPending.value"
      class="flex min-h-48 items-center justify-center"
      role="status"
    >
      <span class="loading loading-spinner loading-lg" aria-hidden="true" />
      <span class="sr-only">Loading Journal Day</span>
    </div>
    <div
      v-else-if="dayQuery.isError.value"
      role="alert"
      class="alert alert-error mt-7"
    >
      <span>Could not load this Journal Day.</span>
      <button class="btn btn-sm" type="button" @click="dayQuery.refetch()">
        Try again
      </button>
    </div>
    <div
      v-else-if="contributions.length === 0"
      class="card card-border mt-7 bg-base-100"
    >
      <div class="card-body items-center py-12 text-center">
        <h2 class="card-title">Nothing recorded yet</h2>
        <p class="max-w-md text-base-content/70">
          Journal Days can be empty. Add a note above whenever you are ready.
        </p>
      </div>
    </div>
    <ol
      v-else
      class="timeline timeline-vertical timeline-compact mt-8"
      aria-label="Day timeline"
    >
      <li v-for="(contribution, index) in contributions" :key="contribution.id">
        <hr v-if="index > 0" class="bg-base-300" />
        <div class="timeline-middle" aria-hidden="true">
          <span class="block size-3 rounded-full bg-base-content/30" />
        </div>
        <div class="timeline-end mb-7 w-[calc(100%-1.5rem)]">
          <ContributionCard
            :contribution="contribution"
            :revisions="revisions[contribution.id]"
            :busy="submitting"
            @edit="saveEdit"
            @delete="changeDeletion($event, true)"
            @restore="changeDeletion($event, false)"
            @load-history="loadHistory"
          />
        </div>
        <hr v-if="index < contributions.length - 1" class="bg-base-300" />
      </li>
    </ol>
  </section>
</template>
