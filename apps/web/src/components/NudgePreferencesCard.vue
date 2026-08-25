<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { reactive, ref, watch } from 'vue';

import { useAuthentication } from '../auth';
import { createUuidV7 } from '../journal/api';
import { getNudgePreferences, updateNudgePreferences } from '../nudge/api';
import { useUiStore } from '../stores/ui';

const auth = useAuthentication();
const ui = useUiStore();
const queryClient = useQueryClient();
const busy = ref(false);
const error = ref('');
const form = reactive({ quietStartHour: 21, quietEndHour: 8, dailyLimit: 1 });
const query = useQuery({
  queryKey: ['nudge-preferences'],
  queryFn: getNudgePreferences,
});

watch(
  () => query.data.value,
  (value) => {
    if (value === undefined) return;
    form.quietStartHour = value.quietStartHour;
    form.quietEndHour = value.quietEndHour;
    form.dailyLimit = value.dailyLimit;
  },
  { immediate: true },
);

async function save(): Promise<void> {
  const preference = query.data.value;
  const csrfToken = auth.status.value?.csrfToken;
  if (preference === undefined || csrfToken === undefined) return;
  busy.value = true;
  error.value = '';
  try {
    const updated = await updateNudgePreferences({
      preference,
      changes: { ...form },
      csrfToken,
      idempotencyKey: `nudge-preferences-${createUuidV7()}`,
    });
    queryClient.setQueryData(['nudge-preferences'], updated);
    ui.announce('Nudge limits and quiet hours saved');
  } catch (caught) {
    error.value =
      caught instanceof Error
        ? caught.message
        : 'Nudge preferences could not be saved.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form
    class="card card-border bg-base-100"
    aria-labelledby="nudge-preferences-title"
    @submit.prevent="save"
  >
    <div class="card-body">
      <h2 id="nudge-preferences-title" class="card-title">Nudge delivery</h2>
      <p class="text-sm text-base-content/70">
        Quiet hours use your owner timezone. Requirement states remain visible,
        and processor failures never consume the daily limit.
      </p>
      <div v-if="query.isLoading.value" role="status">
        <span class="loading loading-spinner loading-sm" aria-hidden="true" />
        Loading delivery settings
      </div>
      <div v-else class="grid gap-3 sm:grid-cols-3">
        <fieldset class="fieldset">
          <legend class="fieldset-legend">
            <label for="quiet-start">Quiet hours start</label>
          </legend>
          <input
            id="quiet-start"
            v-model.number="form.quietStartHour"
            class="input w-full"
            type="number"
            min="0"
            max="23"
            required
          />
        </fieldset>
        <fieldset class="fieldset">
          <legend class="fieldset-legend">
            <label for="quiet-end">Quiet hours end</label>
          </legend>
          <input
            id="quiet-end"
            v-model.number="form.quietEndHour"
            class="input w-full"
            type="number"
            min="0"
            max="23"
            required
          />
        </fieldset>
        <fieldset class="fieldset">
          <legend class="fieldset-legend">
            <label for="daily-limit">Daily digest limit</label>
          </legend>
          <input
            id="daily-limit"
            v-model.number="form.dailyLimit"
            class="input w-full"
            type="number"
            min="0"
            max="24"
            required
          />
        </fieldset>
      </div>
      <p v-if="query.data.value" class="text-xs text-base-content/60">
        Owner timezone: {{ query.data.value.ownerTimezone }} · hour values use
        24-hour local time.
      </p>
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      <div class="card-actions justify-end">
        <button
          class="btn"
          type="submit"
          :disabled="busy || query.isLoading.value"
        >
          Save delivery settings
        </button>
      </div>
    </div>
  </form>
</template>
