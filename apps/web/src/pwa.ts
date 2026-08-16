import { readonly, ref } from 'vue';
import { registerSW } from 'virtual:pwa-register';

const needRefresh = ref(false);
const offlineReady = ref(false);
const error = ref<Error>();
let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined;

export function installPwa(): void {
  updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      needRefresh.value = true;
    },
    onOfflineReady() {
      offlineReady.value = true;
    },
    onRegisterError(cause) {
      error.value =
        cause instanceof Error
          ? cause
          : new Error('Service worker registration failed');
    },
  });
}

async function applyUpdate(): Promise<void> {
  await updateServiceWorker?.(true);
}
function dismissUpdate(): void {
  needRefresh.value = false;
}

export const pwaStatus = {
  applyUpdate,
  dismissUpdate,
  error: readonly(error),
  needRefresh: readonly(needRefresh),
  offlineReady: readonly(offlineReady),
};
