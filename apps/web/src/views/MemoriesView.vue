<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useDebounce } from '@vueuse/core';
import type { MemoryResource } from '@journal/contracts';
import { computed, ref } from 'vue';

import { useAuthentication } from '../auth';
import AppDialog from '../components/AppDialog.vue';
import { createUuidV7 } from '../journal/api';
import { listMemories, mutateMemory } from '../memory/api';

const auth = useAuthentication();
const queryClient = useQueryClient();
const search = ref('');
const debouncedSearch = useDebounce(search, 250);
const includeDeleted = ref(false);
const editor = ref<HTMLDialogElement & { open(): void; close(): void }>();
const confirmation = ref<HTMLDialogElement & { open(): void; close(): void }>();
const selected = ref<MemoryResource>();
const content = ref('');
const rationale = ref('');
const busy = ref(false);
const message = ref('');
const error = ref('');

const query = useQuery({
  queryKey: computed(() => [
    'memories',
    debouncedSearch.value,
    includeDeleted.value,
  ]),
  queryFn: () =>
    listMemories({
      ...(debouncedSearch.value ? { q: debouncedSearch.value } : {}),
      includeDisabled: true,
      includeDeleted: includeDeleted.value,
    }),
});

function csrfToken(): string {
  const token = auth.status.value?.csrfToken;
  if (token === undefined)
    throw new Error('Your session needs to be refreshed.');
  return token;
}

async function mutate(
  memory: MemoryResource,
  mutation: Parameters<typeof mutateMemory>[0]['mutation'],
): Promise<void> {
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    await mutateMemory({
      memoryId: memory.id,
      revision: memory.revision,
      mutation,
      csrfToken: csrfToken(),
      idempotencyKey: createUuidV7(),
    });
    message.value = `Memory ${mutation.operation.replace('_', ' ')} saved.`;
    editor.value?.close();
    confirmation.value?.close();
    await queryClient.invalidateQueries({ queryKey: ['memories'] });
  } catch (caught) {
    error.value =
      caught instanceof Error
        ? caught.message
        : 'The memory could not be changed.';
  } finally {
    busy.value = false;
  }
}

function edit(memory: MemoryResource): void {
  selected.value = memory;
  content.value = memory.currentRevision.content;
  rationale.value = memory.currentRevision.rationale;
  editor.value?.open();
}

async function saveEdit(): Promise<void> {
  const memory = selected.value;
  if (memory === undefined) return;
  await mutate(memory, {
    operation: 'edit',
    memory: {
      type: memory.currentRevision.type,
      content: content.value,
      rationale: rationale.value,
      scope: memory.currentRevision.scope,
    },
  });
}

function askDelete(memory: MemoryResource): void {
  selected.value = memory;
  confirmation.value?.open();
}

function typeLabel(value: string): string {
  return value.replaceAll('_', ' ');
}
</script>

<template>
  <section aria-labelledby="memories-title">
    <p class="text-xs font-semibold uppercase text-base-content/60">
      AI context
    </p>
    <h1 id="memories-title" class="mt-1 text-3xl font-bold sm:text-4xl">
      Memories & rules
    </h1>
    <p class="mt-3 max-w-3xl text-base-content/70">
      Only memories you explicitly approve can affect future processing. Every
      rule remains visible, scoped, revisioned, and under your control.
    </p>

    <div class="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end">
      <label class="fieldset min-w-0 flex-1">
        <span class="fieldset-legend">Search memories</span>
        <input
          v-model="search"
          class="input w-full"
          type="search"
          maxlength="100"
          placeholder="Search content, rationale, or type"
        />
      </label>
      <label class="label mb-2 cursor-pointer justify-start gap-3">
        <input v-model="includeDeleted" class="checkbox" type="checkbox" />
        Show deleted history
      </label>
    </div>

    <div
      v-if="message"
      class="alert alert-success alert-soft mt-4"
      role="status"
    >
      {{ message }}
    </div>
    <div v-if="error" class="alert alert-error alert-soft mt-4" role="alert">
      <span>{{ error }}</span
      ><button class="btn btn-ghost btn-sm" type="button" @click="error = ''">
        Dismiss
      </button>
    </div>
    <div
      v-if="query.isPending.value"
      class="mt-8 flex justify-center"
      role="status"
    >
      <span class="loading loading-spinner" aria-hidden="true" /><span
        class="sr-only"
        >Loading memories</span
      >
    </div>
    <div
      v-else-if="query.isError.value"
      class="alert alert-error mt-6"
      role="alert"
    >
      <span>Memories could not be loaded.</span
      ><button class="btn btn-sm" type="button" @click="query.refetch()">
        Try again
      </button>
    </div>
    <div
      v-else-if="query.data.value?.length === 0"
      class="card card-border mt-6"
    >
      <div class="card-body">
        <h2 class="card-title">No matching memories</h2>
        <p class="text-base-content/70">
          Occurrence-only corrections stay local and never appear here.
        </p>
      </div>
    </div>
    <ul
      v-else
      class="list mt-6 gap-3"
      aria-label="Persistent memories and rules"
    >
      <li
        v-for="memory in query.data.value"
        :key="memory.id"
        class="list-row card card-border bg-base-100 p-4"
      >
        <div class="list-col-grow min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <strong class="break-words">{{
              memory.currentRevision.content
            }}</strong>
            <span class="badge badge-outline">{{
              typeLabel(memory.currentRevision.type)
            }}</span>
            <span
              v-if="memory.currentRevision.approvalState === 'pending'"
              class="badge badge-warning badge-soft"
              >Needs approval</span
            >
            <span
              v-else-if="memory.currentRevision.enabled"
              class="badge badge-success badge-soft"
              >Enabled</span
            >
            <span v-else class="badge badge-ghost">Disabled</span>
            <span
              v-if="memory.currentRevision.deletedAt"
              class="badge badge-error badge-soft"
              >Deleted</span
            >
          </div>
          <p class="mt-2 text-sm text-base-content/70">
            {{ memory.currentRevision.rationale }}
          </p>
          <p class="mt-2 text-xs text-base-content/60">
            Scope: {{ typeLabel(memory.currentRevision.scope.kind) }} · Creator:
            {{ memory.currentRevision.creator }} · Revision
            {{ memory.revision }}
          </p>
          <details class="collapse collapse-arrow mt-3 bg-base-200">
            <summary class="collapse-title text-sm font-medium">
              Revision history
            </summary>
            <div class="collapse-content">
              <ol class="space-y-2 text-sm">
                <li v-for="revision in memory.history" :key="revision.id">
                  Revision {{ revision.revision }} ·
                  {{ revision.approvalState }} ·
                  {{ revision.enabled ? 'enabled' : 'disabled' }} ·
                  {{ new Date(revision.createdAt).toLocaleString() }}
                </li>
              </ol>
              <p
                v-if="memory.historyTruncated"
                class="mt-2 text-xs text-base-content/60"
              >
                Only the latest 50 revisions are shown.
              </p>
            </div>
          </details>
          <div
            v-if="!memory.currentRevision.deletedAt"
            class="mt-3 flex flex-wrap gap-2"
          >
            <button
              v-if="memory.currentRevision.approvalState === 'pending'"
              class="btn btn-sm"
              type="button"
              :disabled="busy"
              @click="mutate(memory, { operation: 'approve' })"
            >
              Approve and enable
            </button>
            <label v-else class="label cursor-pointer gap-2">
              <input
                class="toggle"
                type="checkbox"
                :checked="memory.currentRevision.enabled"
                :disabled="busy"
                :aria-label="`${memory.currentRevision.enabled ? 'Disable' : 'Enable'} ${memory.currentRevision.content}`"
                @change="
                  mutate(memory, {
                    operation: memory.currentRevision.enabled
                      ? 'disable'
                      : 'enable',
                  })
                "
              />
              {{ memory.currentRevision.enabled ? 'Enabled' : 'Disabled' }}
            </label>
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="busy"
              @click="edit(memory)"
            >
              Edit
            </button>
            <button
              class="btn btn-error btn-soft btn-sm"
              type="button"
              :disabled="busy"
              @click="askDelete(memory)"
            >
              Delete
            </button>
          </div>
        </div>
      </li>
    </ul>

    <AppDialog id="memory-editor" ref="editor" title="Edit memory">
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Memory content</legend>
        <textarea
          v-model="content"
          class="textarea min-h-28 w-full"
          maxlength="500"
        />
      </fieldset>
      <fieldset class="fieldset mt-3">
        <legend class="fieldset-legend">Rationale</legend>
        <textarea
          v-model="rationale"
          class="textarea min-h-20 w-full"
          maxlength="500"
        />
      </fieldset>
      <p class="mt-3 text-sm text-base-content/70">
        Saving appends an immutable revision and preserves the prior content.
      </p>
      <template #actions
        ><button class="btn btn-ghost" type="button" @click="editor?.close()">
          Cancel</button
        ><button
          class="btn"
          type="button"
          :disabled="busy || !content.trim() || !rationale.trim()"
          @click="saveEdit"
        >
          Save revision
        </button></template
      >
    </AppDialog>
    <AppDialog id="memory-delete" ref="confirmation" title="Delete memory?">
      <p>
        This immediately removes the memory from future processing while
        preserving a content-private audit event and revision history during the
        retention period.
      </p>
      <template #actions
        ><button
          class="btn btn-ghost"
          type="button"
          @click="confirmation?.close()"
        >
          Cancel</button
        ><button
          class="btn btn-error"
          type="button"
          :disabled="busy"
          @click="selected && mutate(selected, { operation: 'delete' })"
        >
          Delete memory
        </button></template
      >
    </AppDialog>
  </section>
</template>
