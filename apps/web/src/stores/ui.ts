import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useUiStore = defineStore('ui', () => {
  const navigationOpen = ref(false);
  const liveMessage = ref('');

  function announce(message: string): void {
    liveMessage.value = '';
    queueMicrotask(() => {
      liveMessage.value = message;
    });
  }

  function closeNavigation(): void {
    navigationOpen.value = false;
  }

  return { announce, closeNavigation, liveMessage, navigationOpen };
});
