<script setup lang="ts">
import type {
  ContributionResource,
  ContributionRevisionResource,
} from '@journal/contracts';
import { computed, ref, watch } from 'vue';

import AppDialog from './AppDialog.vue';
import { displayCaptureTime } from '../journal/date';
import {
  previewPermanentDeletion,
  requestPermanentDeletion,
} from '../retention/api';
import type { PermanentDeletionPreview } from '@journal/contracts';

const props = defineProps<{
  contribution: ContributionResource;
  revisions: readonly ContributionRevisionResource[] | undefined;
  busy: boolean | undefined;
  localStatus?: 'pending' | 'conflict' | undefined;
  csrfToken?: string;
}>();
const emit = defineEmits<{
  delete: [contribution: ContributionResource];
  edit: [contribution: ContributionResource, text: string, reason: string];
  loadHistory: [contribution: ContributionResource];
  restore: [contribution: ContributionResource];
  permanentlyDeleted: [contributionId: string];
}>();

const editing = ref(false);
const draft = ref('');
const reason = ref('');
const historyDialog = ref<InstanceType<typeof AppDialog>>();
const deleteDialog = ref<InstanceType<typeof AppDialog>>();
const permanentDialog = ref<InstanceType<typeof AppDialog>>();
const permanentPreview = ref<PermanentDeletionPreview>();
const permanentError = ref('');
const permanentBusy = ref(false);
const sourceLabel = computed(() =>
  props.contribution.sourceType === 'nudge_response'
    ? 'Nudge response'
    : 'Typed note',
);

function beginEdit(): void {
  draft.value = props.contribution.currentRevision?.text ?? '';
  reason.value = '';
  editing.value = true;
}

function save(): void {
  if (draft.value.trim() === '') return;
  emit('edit', props.contribution, draft.value, reason.value);
}

function openHistory(): void {
  emit('loadHistory', props.contribution);
  historyDialog.value?.open();
}

async function openPermanentDeletion(): Promise<void> {
  if (props.csrfToken === undefined) return;
  permanentBusy.value = true;
  permanentError.value = '';
  permanentDialog.value?.open();
  try {
    permanentPreview.value = await previewPermanentDeletion(
      { entityKind: 'contribution', entityId: props.contribution.id },
      props.csrfToken,
    );
  } catch (error) {
    permanentError.value =
      error instanceof Error ? error.message : 'Preview failed.';
  } finally {
    permanentBusy.value = false;
  }
}

async function permanentlyDelete(): Promise<void> {
  if (props.csrfToken === undefined || !permanentPreview.value?.eligible)
    return;
  permanentBusy.value = true;
  permanentError.value = '';
  try {
    await requestPermanentDeletion(
      { entityKind: 'contribution', entityId: props.contribution.id },
      props.csrfToken,
    );
    permanentDialog.value?.close();
    emit('permanentlyDeleted', props.contribution.id);
  } catch (error) {
    permanentError.value =
      error instanceof Error ? error.message : 'Deletion failed.';
  } finally {
    permanentBusy.value = false;
  }
}

watch(
  () => props.contribution.currentRevision?.revision,
  () => {
    editing.value = false;
  },
);
</script>

<template>
  <article
    class="card card-border bg-base-100 shadow-sm"
    :class="{ 'opacity-70': contribution.deletedAt !== undefined }"
    :aria-label="`${sourceLabel}, revision ${contribution.currentRevision?.revision ?? 0}`"
  >
    <div class="card-body gap-3 p-4 sm:p-5">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p class="font-semibold">{{ sourceLabel }}</p>
          <p class="text-xs text-base-content/60">
            Captured
            {{
              displayCaptureTime(
                contribution.capturedAt,
                contribution.capturedTimezone,
              )
            }}
            · {{ contribution.capturedTimezone }}
          </p>
        </div>
        <span v-if="localStatus === 'pending'" class="badge badge-info"
          >Saved locally</span
        >
        <span v-else-if="localStatus === 'conflict'" class="badge badge-warning"
          >Needs review</span
        >
        <span v-else-if="contribution.deletedAt" class="badge badge-warning"
          >Deleted</span
        >
        <span v-else class="badge badge-ghost">Manual source</span>
      </div>

      <form v-if="editing" class="space-y-3" @submit.prevent="save">
        <label class="fieldset">
          <span class="fieldset-legend">Contribution text</span>
          <textarea
            v-model="draft"
            class="textarea min-h-32 w-full"
            required
            autofocus
          />
        </label>
        <label class="fieldset">
          <span class="fieldset-legend">Reason for edit (optional)</span>
          <input
            v-model="reason"
            class="input w-full"
            placeholder="Corrected wording"
          />
        </label>
        <div class="flex flex-wrap justify-end gap-2">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            @click="editing = false"
          >
            Cancel
          </button>
          <button
            class="btn btn-sm"
            type="submit"
            :disabled="busy || !draft.trim()"
          >
            Save revision
          </button>
        </div>
      </form>
      <p v-else class="whitespace-pre-wrap text-base leading-relaxed">
        {{ contribution.currentRevision?.text }}
      </p>

      <div v-if="!editing" class="card-actions items-center justify-end">
        <button
          v-if="localStatus === undefined"
          class="btn btn-ghost btn-sm"
          type="button"
          @click="openHistory"
        >
          History
        </button>
        <button
          v-if="contribution.deletedAt"
          class="btn btn-sm"
          type="button"
          :disabled="busy"
          @click="emit('restore', contribution)"
        >
          Restore
        </button>
        <button
          v-if="contribution.deletedAt && csrfToken"
          class="btn btn-ghost btn-sm text-error"
          type="button"
          :disabled="busy"
          @click="openPermanentDeletion"
        >
          Delete permanently
        </button>
        <template v-if="!contribution.deletedAt && localStatus !== 'pending'">
          <button class="btn btn-ghost btn-sm" type="button" @click="beginEdit">
            Edit
          </button>
          <button
            class="btn btn-ghost btn-sm text-error"
            type="button"
            @click="deleteDialog?.open()"
          >
            Delete
          </button>
        </template>
      </div>
    </div>
  </article>

  <AppDialog
    :id="`history-${contribution.id}`"
    ref="historyDialog"
    title="Revision history"
  >
    <p class="mb-4 text-sm text-base-content/70">
      Every saved version remains available for auditability.
    </p>
    <span v-if="revisions === undefined" class="loading loading-spinner" />
    <ol v-else class="space-y-4">
      <li
        v-for="revision in revisions"
        :key="revision.id"
        class="border-l-2 border-base-300 pl-4"
      >
        <p class="text-sm font-semibold">Revision {{ revision.revision }}</p>
        <p class="text-xs text-base-content/60">
          {{ new Date(revision.createdAt).toLocaleString() }} ·
          {{ revision.authority }}
        </p>
        <p v-if="revision.editReason" class="mt-1 text-sm italic">
          {{ revision.editReason }}
        </p>
        <p class="mt-2 whitespace-pre-wrap">{{ revision.text }}</p>
      </li>
    </ol>
    <template #actions="{ close }">
      <button class="btn" type="button" @click="close">Close</button>
    </template>
  </AppDialog>

  <AppDialog
    :id="`permanent-delete-${contribution.id}`"
    ref="permanentDialog"
    title="Permanently delete this contribution?"
  >
    <span
      v-if="permanentBusy && !permanentPreview"
      class="loading loading-spinner"
      role="status"
      aria-label="Loading deletion impact"
    />
    <div
      v-else-if="permanentError"
      role="alert"
      class="alert alert-error alert-soft"
    >
      <span>{{ permanentError }}</span>
    </div>
    <template v-else-if="permanentPreview">
      <div role="alert" class="alert alert-warning alert-soft">
        <span>
          This cannot be undone. Database history, derived search data, audio,
          staging chunks, server caches, and hosted exports are removed or
          invalidated. Downloaded exports remain outside this system.
        </span>
      </div>
      <p class="mt-4 text-sm">
        Eligible after
        {{ new Date(permanentPreview.eligibleAt).toLocaleString() }}.
      </p>
      <ul class="mt-3 list-disc space-y-1 pl-5 text-sm text-base-content/70">
        <li v-for="impact in permanentPreview.impacts" :key="impact.facet">
          {{ impact.detail }}
        </li>
      </ul>
    </template>
    <template #actions="{ close }">
      <button class="btn btn-ghost" type="button" @click="close">Cancel</button>
      <button
        class="btn btn-error"
        type="button"
        :disabled="permanentBusy || !permanentPreview?.eligible"
        @click="permanentlyDelete"
      >
        Permanently delete
      </button>
    </template>
  </AppDialog>

  <AppDialog
    :id="`delete-${contribution.id}`"
    ref="deleteDialog"
    title="Delete this contribution?"
  >
    <div role="alert" class="alert alert-warning alert-soft">
      <span>
        This removes the contribution from the active journal and any derived
        views. It remains recoverable during the deletion grace period and may
        still exist in backups.
      </span>
    </div>
    <template #actions="{ close }">
      <button class="btn btn-ghost" type="button" @click="close">Cancel</button>
      <button
        class="btn btn-error"
        type="button"
        :disabled="busy"
        @click="
          emit('delete', contribution);
          close();
        "
      >
        Delete contribution
      </button>
    </template>
  </AppDialog>
</template>
