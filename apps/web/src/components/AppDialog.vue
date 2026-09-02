<script setup lang="ts">
import { ref } from 'vue';

defineProps<{ title: string }>();
const emit = defineEmits<{ closed: [] }>();
const dialog = ref<HTMLDialogElement>();
let returnFocusTo: HTMLElement | undefined;

function open(): void {
  if (dialog.value?.open) return;
  returnFocusTo =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  dialog.value?.showModal();
}

function close(): void {
  dialog.value?.close();
}

function closed(): void {
  emit('closed');
  returnFocusTo?.focus();
  returnFocusTo = undefined;
}

defineExpose({ close, open });
</script>

<template>
  <dialog
    ref="dialog"
    class="modal"
    :aria-labelledby="`${$attrs.id}-title`"
    @close="closed"
  >
    <div class="modal-box">
      <h2 :id="`${$attrs.id}-title`" class="text-lg font-bold">{{ title }}</h2>
      <div class="py-4"><slot /></div>
      <div class="modal-action"><slot name="actions" :close="close" /></div>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button aria-label="Close dialog">Close</button>
    </form>
  </dialog>
</template>
