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
  createUuidV7,
  listContributionRevisions,
  setContributionDeleted,
} from '../journal/api';
import { type TextMutation, useOfflineJournal } from '../journal/offline';
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
const offline = useOfflineJournal();
const ownerId = auth.status.value?.ownerId;
if (ownerId !== undefined) await offline.initialize(ownerId);
const newText = ref('');
const localSecret = ref('');
const localStorageError = ref('');
const selectedDate = ref(journalDate.value);
const submitting = ref(false);
const errorMessage = ref('');
const revisions = reactive<
  Record<string, readonly ContributionRevisionResource[] | undefined>
>({});
const conflict = ref<{
  current: ContributionResource;
  draft: string;
  reason: string;
}>();
const pendingMutations = ref<readonly TextMutation[]>([]);

const dayQuery = useQuery({
  queryKey: computed(() => ['journal-day', journalDate.value]),
  queryFn: () => offline.readDay(journalDate.value),
});
const contributions = computed(() => {
  const byId = new Map(
    (dayQuery.data.value?.contributions ?? []).map((item) => [item.id, item]),
  );
  for (const mutation of pendingMutations.value) {
    if (mutation.kind === 'create') {
      const input = mutation.input;
      byId.set(input.contributionId, {
        id: input.contributionId,
        journalDayId: input.proposedJournalDayId,
        journalDate: input.journalDate,
        authorId: auth.status.value?.ownerId ?? input.contributionId,
        sourceType: input.sourceType,
        capturedAt: input.capturedAt,
        capturedTimezone: input.capturedTimezone,
        journalTimezone: input.journalTimezone,
        journalDateAssignment: input.journalDateAssignment,
        ...(input.elicitingNudgeId === undefined
          ? {}
          : { elicitingNudgeId: input.elicitingNudgeId }),
        currentRevision: {
          id: input.revisionId,
          contributionId: input.contributionId,
          revision: 1,
          text: input.text,
          authority: 'manual',
          authorId: auth.status.value?.ownerId ?? input.contributionId,
          createdAt: input.capturedAt,
        },
      });
    } else {
      const current = byId.get(mutation.contributionId);
      if (current?.currentRevision !== undefined)
        byId.set(mutation.contributionId, {
          ...current,
          currentRevision: {
            ...current.currentRevision,
            id: mutation.revisionId,
            revision: mutation.baseRevision + 1,
            text: mutation.text,
            ...(mutation.editReason === undefined
              ? {}
              : { editReason: mutation.editReason }),
          },
        });
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.capturedAt.localeCompare(right.capturedAt),
  );
});
const activeCount = computed(
  () =>
    contributions.value.filter((item) => item.deletedAt === undefined).length,
);
const dayTitle = computed(() =>
  props.date === undefined ? 'Today' : displayJournalDate(journalDate.value),
);
const cacheSize = computed(() => {
  const bytes = offline.cacheBytes.value;
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
});

function localStatus(id: string): 'pending' | 'conflict' | undefined {
  if (offline.conflict.value?.current.id === id) return 'conflict';
  return pendingMutations.value.some((mutation) =>
    mutation.kind === 'create'
      ? mutation.input.contributionId === id
      : mutation.contributionId === id,
  )
    ? 'pending'
    : undefined;
}

watch(journalDate, (value) => {
  selectedDate.value = value;
  errorMessage.value = '';
  conflict.value = undefined;
  void loadPending();
});

watch(
  () => offline.conflict.value,
  (value) => {
    conflict.value = value;
  },
  { immediate: true },
);

watch(
  () => offline.pendingCount.value,
  async () => {
    await loadPending();
    await queryClient.invalidateQueries({
      queryKey: ['journal-day', journalDate.value],
    });
    await queryClient.invalidateQueries({ queryKey: ['journal-days'] });
  },
);

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
  await loadPending();
}

async function loadPending(): Promise<void> {
  pendingMutations.value = await offline.pendingForDay(journalDate.value);
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
    const input = {
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
        journalDate.value === localJournalDate() ? 'default' : 'user_override',
    } as const;
    await offline.enqueueCreate(input, `create-${createUuidV7()}`);
    newText.value = '';
    ui.announce('Contribution saved locally');
    await loadPending();
    await offline.replay(csrfToken());
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
    const revision = contribution.currentRevision?.revision;
    if (revision === undefined)
      throw new Error('This contribution cannot be edited.');
    await offline.enqueueEdit({
      contributionId: contribution.id,
      journalDate: contribution.journalDate,
      baseRevision: revision,
      revisionId: createUuidV7(),
      text,
      ...(reason.trim() === '' ? {} : { editReason: reason.trim() }),
      idempotencyKey: `edit-${createUuidV7()}`,
    });
    ui.announce('Revision saved locally');
    await loadPending();
    await offline.replay(csrfToken());
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    submitting.value = false;
  }
}

async function retryConflict(): Promise<void> {
  await offline.resolveConflict(csrfToken(), true);
  await refresh();
}

async function discardConflict(): Promise<void> {
  await offline.resolveConflict(csrfToken(), false);
  conflict.value = undefined;
  await refresh();
}

async function configureOfflineStorage(): Promise<void> {
  localStorageError.value = '';
  try {
    if (offline.configured.value) await offline.unlock(localSecret.value);
    else await offline.setup(localSecret.value);
    localSecret.value = '';
    await offline.replay(csrfToken());
    await dayQuery.refetch();
    await loadPending();
  } catch (error) {
    localStorageError.value =
      error instanceof Error
        ? error.message
        : 'Offline storage could not be unlocked.';
  }
}

async function clearOfflineCache(): Promise<void> {
  await offline.clearReadCache();
  ui.announce('Offline read cache cleared');
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
  revisions[contribution.id] = undefined;
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

await loadPending();
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
            @click="discardConflict"
          >
            Keep latest saved version
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="!offline.unlocked.value"
      class="card card-border mt-7 bg-base-200"
    >
      <form
        class="card-body gap-3 p-4 sm:p-5"
        @submit.prevent="configureOfflineStorage"
      >
        <h2 class="card-title">
          {{
            offline.configured.value
              ? 'Unlock offline journal'
              : 'Enable offline journal'
          }}
        </h2>
        <p class="text-sm text-base-content/70">
          Journal text is encrypted on this device with a separate local secret.
          It is never sent to the server or saved by the browser.
          <template v-if="!offline.configured.value">
            If you lose it, unsynced local notes cannot be recovered.
          </template>
        </p>
        <label class="fieldset">
          <span class="fieldset-legend">Local unlock secret</span>
          <input
            v-model="localSecret"
            class="input w-full"
            type="password"
            minlength="8"
            autocomplete="off"
            required
          />
        </label>
        <p v-if="localStorageError" class="text-sm text-error" role="alert">
          {{ localStorageError }}
        </p>
        <div class="card-actions justify-end">
          <button class="btn" type="submit">
            {{ offline.configured.value ? 'Unlock' : 'Enable and unlock' }}
          </button>
        </div>
      </form>
    </div>

    <div
      v-else
      role="status"
      class="alert alert-info alert-soft mt-7 sm:alert-horizontal"
    >
      <span>
        Offline journal unlocked · {{ offline.pendingCount.value }} pending ·
        {{ offline.cacheDays.value }} cached days ({{ cacheSize }}) · cached
        copies expire 30 days after refresh
        <template v-if="offline.lastReadFromCache.value">
          · viewing cached copy</template
        >
      </span>
      <button
        v-if="offline.cacheDays.value > 0"
        class="btn btn-ghost btn-sm"
        type="button"
        @click="clearOfflineCache"
      >
        Clear cached reads
      </button>
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
            :disabled="
              submitting ||
              !newText.trim() ||
              !offline.readyForLocalCapture.value
            "
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
      v-else-if="dayQuery.isError.value && contributions.length === 0"
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
            :local-status="localStatus(contribution.id)"
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
