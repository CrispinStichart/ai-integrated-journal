<script setup lang="ts">
import type { SearchLayer } from '@journal/contracts';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/vue-query';
import { computed, reactive, ref } from 'vue';

import { useAuthentication } from '../auth';
import { listProcessors } from '../processor/api';
import {
  askGroundedAnswer,
  getGroundedAnswer,
  lexicalSearch,
  type SearchInput,
} from '../search/api';

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
  mode: 'hybrid' as 'lexical' | 'semantic' | 'hybrid',
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
const answerId = ref<string>();
const auth = useAuthentication();

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
const answerMutation = useMutation({
  mutationFn: askGroundedAnswer,
  onSuccess: (answer) => {
    answerId.value = answer.id;
  },
});
const answerQuery = useQuery({
  queryKey: computed(() => ['grounded-answer', answerId.value]),
  enabled: computed(() => answerId.value !== undefined),
  queryFn: () => {
    if (answerId.value === undefined)
      throw new Error('No grounded answer has been requested.');
    return getGroundedAnswer(answerId.value);
  },
  refetchInterval: (query) =>
    query.state.data?.status === 'queued' ||
    query.state.data?.status === 'running'
      ? 750
      : false,
});
const results = computed(
  () => searchQuery.data.value?.pages.flatMap((page) => page.items) ?? [],
);
const fallbackMessage = computed(() => {
  const retrieval = searchQuery.data.value?.pages[0]?.retrieval;
  if (retrieval?.fallbackReason === undefined) return '';
  if (retrieval.fallbackReason === 'provider_unavailable')
    return 'Semantic retrieval is not configured. Showing local lexical matches.';
  if (retrieval.fallbackReason === 'semantic_index_unavailable')
    return 'Semantic indexing is not ready for this model. Showing local lexical matches.';
  return 'Semantic retrieval failed. Showing local lexical matches; your journal was not changed.';
});

function submit(): void {
  const input = formInput();
  if (input === undefined) return;
  submitted.value = input;
}

function formInput(): SearchInput | undefined {
  const q = form.q.trim();
  if (q.length === 0) {
    validationMessage.value = 'Enter words or a quoted phrase to search.';
    return undefined;
  }
  if (selectedLayers.value.length === 0) {
    validationMessage.value = 'Choose at least one source or result layer.';
    return undefined;
  }
  validationMessage.value = '';
  return {
    q,
    mode: form.mode,
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

function ask(): void {
  const input = formInput();
  if (input === undefined) return;
  submitted.value = input;
  answerId.value = undefined;
  const csrfToken = auth.status.value?.csrfToken;
  if (csrfToken === undefined) {
    validationMessage.value =
      'Refresh your session before generating an answer.';
    return;
  }
  answerMutation.mutate({
    csrfToken,
    request: {
      question: input.q,
      mode: input.mode ?? 'hybrid',
      ...(input.layers === undefined ? {} : { layers: input.layers }),
      ...(input.dateFrom === undefined ? {} : { dateFrom: input.dateFrom }),
      ...(input.dateTo === undefined ? {} : { dateTo: input.dateTo }),
      ...(input.contributionTypes === undefined
        ? {}
        : { contributionTypes: input.contributionTypes }),
      ...(input.processorId === undefined
        ? {}
        : { processorId: input.processorId }),
      ...(input.resultType === undefined
        ? {}
        : { resultType: input.resultType }),
      ...(input.entity === undefined ? {} : { entity: input.entity }),
      ...(input.authority === undefined ? {} : { authority: input.authority }),
    },
  });
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
      Search current journal sources and selected derived layers. Hybrid search
      combines local word matching with optional semantic similarity without
      mixing incompatible embedding models.
    </p>

    <form
      class="mt-6 space-y-5"
      aria-label="Journal retrieval"
      @submit.prevent="submit"
    >
      <div
        class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end"
      >
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
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Search method</legend>
          <select v-model="form.mode" class="select" aria-label="Search method">
            <option value="hybrid">Hybrid</option>
            <option value="semantic">Meaning</option>
            <option value="lexical">Words & phrases</option>
          </select>
        </fieldset>
        <div class="flex flex-col gap-2 sm:flex-row">
          <button class="btn" type="submit">Search journal</button>
          <button
            class="btn"
            type="button"
            :disabled="answerMutation.isPending.value"
            @click="ask"
          >
            Answer from evidence
          </button>
        </div>
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
      v-if="fallbackMessage"
      class="alert alert-info mt-5"
      role="status"
      aria-live="polite"
    >
      {{ fallbackMessage }}
    </div>
    <div
      v-if="
        answerMutation.isPending.value ||
        answerQuery.data.value?.status === 'queued' ||
        answerQuery.data.value?.status === 'running'
      "
      class="card card-border mt-6"
      role="status"
      aria-live="polite"
    >
      <div class="card-body flex-row items-center gap-3">
        <span class="loading loading-spinner" aria-hidden="true" />
        <div>
          <h2 class="card-title">Building a grounded answer</h2>
          <p class="text-sm text-base-content/70">
            Generating only from the bounded retrieved sources.
          </p>
        </div>
      </div>
    </div>
    <div
      v-else-if="
        answerMutation.isError.value ||
        answerQuery.isError.value ||
        answerQuery.data.value?.status === 'failed'
      "
      class="alert alert-error mt-6"
      role="alert"
    >
      Answer generation is unavailable or failed. This is a processing failure,
      not a claim that your journal lacks information. Retrieved sources remain
      available below.
    </div>
    <article
      v-else-if="answerQuery.data.value?.status === 'insufficient_support'"
      class="card card-border mt-6"
      aria-labelledby="insufficient-answer-title"
    >
      <div class="card-body">
        <span class="badge badge-warning"
          >Insufficient supporting evidence</span
        >
        <h2 id="insufficient-answer-title" class="card-title">
          I can’t answer that from the retrieved journal material
        </h2>
        <p class="text-base-content/70">
          Try broader wording, fewer filters, or add a relevant journal entry.
          No unsupported recollection was generated.
        </p>
      </div>
    </article>
    <article
      v-else-if="answerQuery.data.value?.status === 'succeeded'"
      class="card card-border mt-6"
      aria-labelledby="grounded-answer-title"
    >
      <div class="card-body">
        <div class="flex flex-wrap items-center gap-2">
          <h2 id="grounded-answer-title" class="card-title">
            Answer from your journal
          </h2>
          <span class="badge badge-outline">AI-generated synthesis</span>
        </div>
        <p class="whitespace-pre-wrap">
          {{ answerQuery.data.value.synthesis }}
        </p>
        <div>
          <h3 class="font-semibold">Retrieved supporting sources</h3>
          <p class="mt-1 text-sm text-base-content/60">
            These are quoted source fragments, separate from the synthesis.
          </p>
          <ul class="list mt-3 gap-3" aria-label="Answer citations">
            <li
              v-for="citation in answerQuery.data.value.citations"
              :key="citation.citationId"
              class="list-row rounded-box border border-base-300 p-4"
            >
              <div class="list-col-grow min-w-0">
                <div class="flex flex-wrap gap-2">
                  <span class="badge badge-ghost">Retrieved quote</span>
                  <span class="badge badge-outline">{{
                    label(citation.layer)
                  }}</span>
                </div>
                <blockquote class="mt-3 border-l-4 border-base-300 pl-4">
                  {{ citation.retrievedQuote }}
                </blockquote>
                <p class="mt-2 text-xs text-base-content/60">
                  Exact revision {{ citation.sourceRevision }} ·
                  {{ citation.journalDate ?? 'Approved memory' }} · UTF-16
                  {{ citation.evidence.startUtf16 }}–{{
                    citation.evidence.endUtf16
                  }}
                </p>
                <RouterLink class="link mt-2 inline-block" :to="citation.href">
                  Open precise supporting evidence
                </RouterLink>
              </div>
            </li>
          </ul>
        </div>
        <details v-if="answerQuery.data.value.lineage" class="mt-2">
          <summary class="cursor-pointer font-semibold">
            Generation details
          </summary>
          <p class="mt-2 text-sm text-base-content/70">
            Prompt {{ answerQuery.data.value.lineage.prompt.version }} · model
            {{ answerQuery.data.value.lineage.model.id }} ·
            {{ answerQuery.data.value.lineage.processingTimeMilliseconds }} ms
          </p>
        </details>
      </div>
    </article>
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
      <p
        v-if="searchQuery.data.value?.pages[0]?.retrieval.cohort"
        class="mt-1 text-xs text-base-content/60"
      >
        Semantic cohort:
        {{ searchQuery.data.value.pages[0].retrieval.cohort.providerId }} /
        {{ searchQuery.data.value.pages[0].retrieval.cohort.modelId }} ·
        {{ searchQuery.data.value.pages[0].retrieval.cohort.dimension }}
        dimensions
      </p>
      <ul class="list mt-4 gap-3" aria-label="Search results">
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
              <span
                v-if="result.retrievalSignals?.semanticRank"
                class="badge badge-ghost"
              >
                Meaning match
              </span>
              <span
                v-if="result.retrievalSignals?.lexicalRank"
                class="badge badge-ghost"
              >
                Word match
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
