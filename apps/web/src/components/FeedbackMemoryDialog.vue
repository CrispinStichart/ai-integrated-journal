<script setup lang="ts">
import type { CreateFeedbackRequest } from '@journal/contracts';
import { ref } from 'vue';

import { useAuthentication } from '../auth';
import { createUuidV7 } from '../journal/api';
import { createFeedback } from '../memory/api';
import AppDialog from './AppDialog.vue';

const props = defineProps<{
  target: CreateFeedbackRequest['target'];
}>();
const emit = defineEmits<{ saved: [message: string] }>();
const dialog = ref<HTMLDialogElement & { open(): void; close(): void }>();
const auth = useAuthentication();
const mode = ref<'occurrence_only' | 'correct_and_remember'>('occurrence_only');
const message = ref('');
const content = ref('');
const rationale = ref('');
const type = ref<
  | 'correction_rule'
  | 'known_entity'
  | 'alias'
  | 'known_fact'
  | 'application_preference'
>('correction_rule');
const busy = ref(false);
const error = ref('');

function open(): void {
  error.value = '';
  dialog.value?.open();
}

function scope() {
  if (type.value === 'known_fact')
    return { kind: 'global_known_fact' as const };
  if (type.value === 'application_preference')
    return { kind: 'global_application_preference' as const };
  return { kind: 'global_transcription' as const };
}

async function save(): Promise<void> {
  const csrfToken = auth.status.value?.csrfToken;
  if (csrfToken === undefined) return;
  busy.value = true;
  error.value = '';
  try {
    const feedback: CreateFeedbackRequest =
      mode.value === 'occurrence_only'
        ? {
            mode: 'occurrence_only',
            target: props.target,
            message: message.value,
          }
        : {
            mode: 'correct_and_remember',
            target: props.target,
            message: message.value,
            memory: {
              type: type.value,
              content: content.value,
              rationale: rationale.value,
              scope: scope(),
            },
            approval: 'approved',
          };
    const result = await createFeedback({
      feedback,
      csrfToken,
      idempotencyKey: createUuidV7(),
    });
    dialog.value?.close();
    emit(
      'saved',
      result.memory === undefined
        ? 'Feedback saved for this occurrence only.'
        : 'Feedback saved and the approved memory is now visible in Memories & rules.',
    );
  } catch (caught) {
    error.value =
      caught instanceof Error ? caught.message : 'Feedback could not be saved.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <button class="btn btn-ghost btn-sm" type="button" @click="open">
    Give feedback
  </button>
  <AppDialog
    :id="`feedback-memory-${target.id}`"
    ref="dialog"
    title="Feedback scope"
  >
    <div v-if="error" class="alert alert-error alert-soft mb-3" role="alert">
      {{ error }}
    </div>
    <fieldset class="fieldset">
      <legend class="fieldset-legend">What should change?</legend>
      <input
        v-model="message"
        class="input w-full"
        data-feedback-message
        maxlength="1000"
        required
      />
    </fieldset>
    <fieldset class="fieldset mt-3">
      <legend class="fieldset-legend">Apply feedback</legend>
      <label class="label cursor-pointer justify-start gap-3">
        <input
          v-model="mode"
          class="radio"
          type="radio"
          :name="`feedback-scope-${target.id}`"
          value="occurrence_only"
        />
        <span
          ><strong>This occurrence only</strong><br /><span
            class="text-sm text-base-content/70"
            >No persistent rule is created.</span
          ></span
        >
      </label>
      <label class="label cursor-pointer justify-start gap-3">
        <input
          v-model="mode"
          class="radio"
          type="radio"
          :name="`feedback-scope-${target.id}`"
          value="correct_and_remember"
        />
        <span
          ><strong>Correct and remember</strong><br /><span
            class="text-sm text-base-content/70"
            >Creates an approved, visible rule for future processing.</span
          ></span
        >
      </label>
    </fieldset>
    <div
      v-if="mode === 'correct_and_remember'"
      class="mt-3 space-y-3 rounded-box bg-base-200 p-3"
    >
      <label class="fieldset">
        <span class="fieldset-legend">Memory type</span>
        <select v-model="type" class="select w-full">
          <option value="correction_rule">Transcription correction</option>
          <option value="known_entity">Known name or place</option>
          <option value="alias">Alias</option>
          <option value="known_fact">Known fact</option>
          <option value="application_preference">Application preference</option>
        </select>
      </label>
      <label class="fieldset"
        ><span class="fieldset-legend">Memory content</span
        ><input
          v-model="content"
          class="input w-full"
          data-memory-content
          maxlength="500"
          required
      /></label>
      <label class="fieldset"
        ><span class="fieldset-legend">Why remember this?</span
        ><input
          v-model="rationale"
          class="input w-full"
          data-memory-rationale
          maxlength="500"
          required
      /></label>
      <div class="alert alert-warning alert-soft text-sm" role="status">
        Saving explicitly approves this scoped memory. You can edit, disable, or
        delete it later.
      </div>
    </div>
    <template #actions>
      <button class="btn btn-ghost" type="button" @click="dialog?.close()">
        Cancel
      </button>
      <button
        class="btn"
        type="button"
        :disabled="
          busy ||
          !message.trim() ||
          (mode === 'correct_and_remember' &&
            (!content.trim() || !rationale.trim()))
        "
        @click="save"
      >
        Save feedback
      </button>
    </template>
  </AppDialog>
</template>
