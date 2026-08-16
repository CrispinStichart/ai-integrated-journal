<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import type { JournalDaySummary } from '@journal/contracts';
import { computed, ref } from 'vue';

import { listJournalDays } from '../journal/api';
import { displayJournalDate, localJournalDate } from '../journal/date';

const today = localJournalDate();
const selectedMonth = ref(today.slice(0, 7));
const additionalPages = ref<readonly JournalDaySummary[]>([]);
const nextCursor = ref<string>();
const loadingMore = ref(false);
const calendarQuery = useQuery({
  queryKey: ['journal-days'],
  queryFn: async () => {
    const page = await listJournalDays();
    nextCursor.value = page.nextCursor;
    return page.items;
  },
});
const summaries = computed(() => [
  ...(calendarQuery.data.value ?? []),
  ...additionalPages.value,
]);
const summaryByDate = computed(
  () =>
    new Map(summaries.value.map((summary) => [summary.journalDate, summary])),
);
const monthLabel = computed(() =>
  new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${selectedMonth.value}-01T12:00:00Z`)),
);
const days = computed(() => {
  const [year = 0, month = 0] = selectedMonth.value.split('-').map(Number);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [
    ...Array.from({ length: firstWeekday }, () => undefined),
    ...Array.from({ length: count }, (_, index) => {
      const date = `${selectedMonth.value}-${String(index + 1).padStart(2, '0')}`;
      return { date, day: index + 1, summary: summaryByDate.value.get(date) };
    }),
  ];
});

function shiftMonth(delta: number): void {
  const date = new Date(`${selectedMonth.value}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  selectedMonth.value = date.toISOString().slice(0, 7);
}

async function loadMore(): Promise<void> {
  if (nextCursor.value === undefined) return;
  loadingMore.value = true;
  try {
    const page = await listJournalDays(nextCursor.value);
    additionalPages.value = [...additionalPages.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } finally {
    loadingMore.value = false;
  }
}
</script>

<template>
  <section aria-labelledby="calendar-title">
    <p class="mb-2 text-sm font-medium text-base-content/60">Your journal</p>
    <h1
      id="calendar-title"
      class="text-3xl font-bold tracking-tight sm:text-4xl"
    >
      Calendar
    </h1>
    <p class="mt-3 max-w-2xl text-base-content/70">
      Browse past, present, or future Journal Days. Counts reflect separate,
      independently recoverable contributions.
    </p>

    <div class="card card-border mt-8 bg-base-100">
      <div class="card-body gap-5 p-4 sm:p-6">
        <div class="flex items-center justify-between gap-3">
          <button
            class="btn btn-ghost btn-square"
            type="button"
            aria-label="Previous month"
            @click="shiftMonth(-1)"
          >
            ←
          </button>
          <div class="text-center">
            <h2 class="text-xl font-semibold">{{ monthLabel }}</h2>
            <input
              v-model="selectedMonth"
              class="input input-sm mt-2"
              type="month"
              aria-label="Choose month"
            />
          </div>
          <button
            class="btn btn-ghost btn-square"
            type="button"
            aria-label="Next month"
            @click="shiftMonth(1)"
          >
            →
          </button>
        </div>

        <div
          v-if="calendarQuery.isPending.value"
          class="flex min-h-64 items-center justify-center"
          role="status"
        >
          <span class="loading loading-spinner loading-lg" aria-hidden="true" />
          <span class="sr-only">Loading calendar summaries</span>
        </div>
        <div
          v-else-if="calendarQuery.isError.value"
          role="alert"
          class="alert alert-error"
        >
          <span>Could not load calendar summaries.</span>
          <button
            class="btn btn-sm"
            type="button"
            @click="calendarQuery.refetch()"
          >
            Try again
          </button>
        </div>
        <template v-else>
          <div
            class="grid grid-cols-7 gap-1 text-center text-xs font-semibold text-base-content/60"
            aria-hidden="true"
          >
            <span
              v-for="name in ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']"
              :key="name"
              >{{ name }}</span
            >
          </div>
          <div
            class="grid grid-cols-7 gap-1"
            role="grid"
            :aria-label="monthLabel"
          >
            <span
              v-for="(item, index) in days"
              :key="item?.date ?? `blank-${index}`"
            >
              <span v-if="item === undefined" class="block aspect-square" />
              <RouterLink
                v-else
                class="btn h-auto min-h-12 w-full flex-col gap-0 px-1 py-2"
                :class="
                  item.date === today
                    ? 'btn-primary'
                    : item.summary
                      ? ''
                      : 'btn-ghost'
                "
                :to="`/journal/${item.date}`"
                role="gridcell"
                :aria-label="`${displayJournalDate(item.date)}${item.summary ? `, ${item.summary.contributionCount} contributions` : ', no contributions'}`"
              >
                <span>{{ item.day }}</span>
                <span v-if="item.summary" class="text-[0.65rem] font-normal">
                  {{ item.summary.contributionCount }}
                  {{ item.summary.contributionCount === 1 ? 'item' : 'items' }}
                </span>
              </RouterLink>
            </span>
          </div>
          <button
            v-if="nextCursor"
            class="btn btn-block"
            type="button"
            :disabled="loadingMore"
            @click="loadMore"
          >
            Load older summaries
          </button>
        </template>
      </div>
    </div>
  </section>
</template>
