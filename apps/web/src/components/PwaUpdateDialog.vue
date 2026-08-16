<script setup lang="ts">
import { ref, watch } from 'vue';

import { pwaStatus } from '../pwa';
import AppDialog from './AppDialog.vue';

const updateDialog = ref<InstanceType<typeof AppDialog>>();

watch(pwaStatus.needRefresh, (needed) => {
  if (needed) updateDialog.value?.open();
});

async function update(): Promise<void> {
  await pwaStatus.applyUpdate();
}

function dismiss(): void {
  pwaStatus.dismissUpdate();
}
</script>

<template>
  <div
    v-if="pwaStatus.offlineReady.value"
    class="toast toast-start toast-bottom z-50"
    role="status"
  >
    <div class="alert alert-success">
      <span>Journal is ready to use offline.</span>
    </div>
  </div>
  <div
    v-if="pwaStatus.error.value"
    class="toast toast-start toast-bottom z-50"
    role="alert"
  >
    <div class="alert alert-error">
      <span>The offline shell could not be updated.</span>
    </div>
  </div>
  <AppDialog
    id="pwa-update-dialog"
    ref="updateDialog"
    title="Update available"
    @closed="dismiss"
  >
    <p>
      A newer version of Journal is ready. Update when you are not capturing an
      entry.
    </p>
    <template #actions="{ close }">
      <button class="btn btn-ghost" type="button" @click="close">Later</button>
      <button class="btn" type="button" @click="update">Update now</button>
    </template>
  </AppDialog>
</template>
