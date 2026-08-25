<script setup lang="ts">
import type { SearchLayer } from '@journal/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query';
import { computed, reactive, ref } from 'vue';

import { listProcessors } from '../processor/api';
import { lexicalSearch, type SearchInput } from '../search/api';

const layerOptions: readonly Readonly<{ value: SearchLayer; label: string }>[] =
  [
    { value: 'typed_text', label: 'Typed text' },
    { value: 'nudge_response', label: 'Nudge responses' },
    { value: 'raw_stt', label: 'Raw STT' },
    { value: 'corrected', label: 'Corrected transcripts' },
    { value: 'cleaned', label: 'Cleaned transcripts' },
    { value: 'observation', label: 'Observations' },
    { value: 'interpretation', label: 'Interpretations' },
    { value: 'summary', label: 'Summaries & accomplishments' },
    { value: 'memory', label: 'Approved memories' },
  ];
const selectedLayers = ref<SearchLayer[]>([
  'typed_text',
  'nudge_response',
  'raw_stt',
  'corrected',
  'cleaned',
]);
const form = reactive({
  q: '',
  dateFrom: '',
  dateTo: '',
  contributionType: '',
  processorId: '',
  resultType: '',
  entity: '',
  authority: '',
});
const submitted = ref<SearchInput>();
const validationMessage = ref('');

const processorQuery = useQuery({
  queryKey: ['processors', 'search-filter'],
  queryFn: listProcessors,
});
const searchQuery = useInfiniteQuery({
  queryKey: computed(() => ['lexical-search', submitted.value]),
  enabled: computed(() => submitted.value !== undefined),
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) => {
    if (submitted.value === undefined)
      throw new Error('Enter a search before requesting results.');
    return lexicalSearch(submitted.value, pageParam);
  },
  getNextPageParam: (lastPage) => lastPage.page.nextCursor,
});
const results = computed(
  () => searchQuery.data.value?.pages.flatMap((page) => page.items) ?? [],
);

function submit(): void {
  const q = form.q.trim();
  if (q.length === 0) {
    validationMessage.value = 'Enter words or a quoted phrase to search.';
    return;
  }
  if (selectedLayers.value.length === 0) {
    validationMessage.value = 'Choose at least one source or result layer.';
    return;
  }
  validationMessage.value = '';
  submitted.value = {
    q,
    layers: [...selectedLayers.value],
    ...(form.dateFrom ? { dateFrom: form.dateFrom } : {}),
    ...(form.dateTo ? { dateTo: form.dateTo } : {}),
    ...(form.contributionType
      ? {
          contributionTypes: [
            form.contributionType as
              'typed_text' | 'recording' | 'nudge_response',
          ],
        }
      : {}),
    ...(form.processorId ? { processorId: form.processorId } : {}),
    ...(form.resultType.trim() ? { resultType: form.resultType.trim() } : {}),
    ...(form.entity.trim() ? { entity: form.entity.trim() } : {}),
    ...(form.authority
      ? { authority: form.authority as 'manual' | 'generated' }
      : {}),
  };
}

function label(value: string): string {
  return value.replaceAll('_', ' ');
}
</script>

<template>
  <section aria-labelledby="search-title">
    <p class="text-xs font-semibold uppercase text-base-content/60">
      Exact-revision retrieval
    </p>
    <h1 id="search-title" class="mt-1 text-3xl font-bold sm:text-4xl">
      Search
    </h1>
    <p class="mt-3 max-w-3xl text-base-content/70">
      Search current journal sources and selected derived layers. Put a phrase
      in quotes for phrase matching; unquoted words support prefix matching.
    </p>

    <form
      class="mt-6 space-y-5"
      aria-label="Lexical search"
      @submit.prevent="submit"
    >
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
        <fieldset class="fieldset min-w-0 flex-1">
          <legend class="fieldset-legend">Words or quoted phrase</legend>
          <input
            v-model="form.q"
            class="input w-full"
            type="search"
            aria-label="Words or quoted phrase"
            maxlength="200"
            placeholder='For example, "morning walk"'
          />
        </fieldset>
        <button class="btn" type="submit">Search journal</button>
      </div>

      <fieldset class="fieldset rounded-box border border-base-300 p-4">
        <legend class="fieldset-legend px-2">Layers to include</legend>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label
            v-for="option in layerOptions"
            :key="option.value"
            class="label cursor-pointer justify-start gap-3"
          >
            <input
              v-model="selectedLayers"
              class="checkbox checkbox-sm"
              type="checkbox"
              :value="option.value"
            />
            {{ option.label }}
          </label>
        </div>
      </fieldset>

      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <fieldset class="fieldset">
          <legend class="fieldset-legend">From date</legend>
          <input
            v-model="form.dateFrom"
            class="input w-full"
            type="date"
            aria-label="From date"
          />
        </fieldset>
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Through date</legend>
          <input
            v-model="form.dateTo"
            class="input w-full"
            type="date"
            aria-label="Through date"
          />
        </fieldset>
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Contribution type</legend>
          <select
            v-model="form.contributionType"
            class="select w-full"
            aria-label="Contribution type"
          >
            <option value="">Any contribution</option>
            <option value="typed_text">Typed text</option>
            <option value="recording">Recording</option>
            <option value="nudge_response">Nudge response</option>
          </select>
        </fieldset>
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Authority</legend>
          <select
            v-model="form.authority"
            class="select w-full"
            aria-label="Authority"
          >
            <option value="">Manual and generated</option>
            <option value="manual">Manual only</option>
            <option value="generated">Generated only</option>
          </select>
        </fieldset>
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Processor</legend>
          <select
            v-model="form.processorId"
            class="select w-full"
            aria-label="Processor"
          >
            <option value="">Any processor</option>
            <option
              v-for="processor in processorQuery.data.value ?? []"
              :key="processor.id"
              :value="processor.id"
            >
              {{ processor.name }}
            </option>
          </select>
        </fieldset>
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Result type</legend>
          <input
            v-model="form.resultType"
            class="input w-full"
            aria-label="Result type"
            maxlength="80"
            placeholder="observation"
          />
        </fieldset>
        <fieldset class="fieldset sm:col-span-2">
          <legend class="fieldset-legend">Person or entity</legend>
          <input
            v-model="form.entity"
            class="input w-full"
            aria-label="Person or entity"
            maxlength="100"
            placeholder="Filter matches to another name or entity"
          />
        </fieldset>
      </div>
    </form>

    <div v-if="validationMessage" class="alert alert-warning mt-5" role="alert">
      {{ validationMessage }}
    </div>
    <div
      v-if="searchQuery.isPending.value && submitted"
      class="mt-8 flex justify-center"
      role="status"
      aria-label="Searching journal"
    >
      <span class="loading loading-spinner" aria-hidden="true" />
    </div>
    <div
      v-else-if="searchQuery.isError.value"
      class="alert alert-error mt-6"
      role="alert"
    >
      <span
        >Search could not be completed. Your journal content was not
        changed.</span
      >
      <button class="btn btn-sm" type="button" @click="searchQuery.refetch()">
        Try again
      </button>
    </div>
    <div
      v-else-if="submitted && results.length === 0"
      class="card card-border mt-6"
    >
      <div class="card-body">
        <h2 class="card-title">No matching journal material</h2>
        <p class="text-base-content/70">
          Try fewer filters or a broader prefix.
        </p>
      </div>
    </div>
    <div v-else-if="results.length > 0" class="mt-8">
      <h2 class="text-xl font-semibold">Retrieved sources and results</h2>
      <p class="mt-1 text-sm text-base-content/60">
        Quotes below are retrieved text, never AI-generated synthesis.
      </p>
      <ul class="list mt-4 gap-3" aria-label="Lexical search results">
        <li
          v-for="result in results"
          :key="result.fragmentId"
          class="list-row card card-border bg-base-100 p-4"
        >
          <div class="list-col-grow min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="badge badge-outline">{{ label(result.layer) }}</span>
              <span class="badge badge-ghost">
                {{
                  result.authority === 'manual'
                    ? 'Manual source'
                    : 'Generated result'
                }}
              </span>
              <span v-if="result.processorName" class="badge badge-ghost">
                {{ result.processorName }}
              </span>
            </div>
            <blockquote class="mt-3 border-l-4 border-base-300 pl-4">
              <template v-for="(segment, index) in result.snippet" :key="index">
                <mark
                  v-if="segment.highlighted"
                  class="rounded-selector bg-warning text-warning-content"
                  >{{ segment.text }}</mark
                ><span v-else>{{ segment.text }}</span>
              </template>
            </blockquote>
            <p class="mt-3 text-xs text-base-content/60">
              Exact revision {{ result.sourceRevision }} ·
              {{ result.journalDate ?? 'Approved memory' }}
            </p>
            <RouterLink class="link mt-3 inline-block" :to="result.href">
              {{
                result.journalDate
                  ? 'Open supporting Journal Day'
                  : 'Open supporting memory'
              }}
            </RouterLink>
          </div>
        </li>
      </ul>
      <button
        v-if="searchQuery.hasNextPage.value"
        class="btn mt-5"
        type="button"
        :disabled="searchQuery.isFetchingNextPage.value"
        @click="searchQuery.fetchNextPage()"
      >
        {{
          searchQuery.isFetchingNextPage.value
            ? 'Loading…'
            : 'Load more results'
        }}
      </button>
    </div>
  </section>
</template>
