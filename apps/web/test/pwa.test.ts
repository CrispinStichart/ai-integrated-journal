// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import type { Ref } from 'vue';
import { nextTick } from 'vue';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  update: vi.fn(async () => undefined),
  captureSnapshot: undefined as unknown as Ref<{ phase: string }>,
}));

vi.mock('virtual:pwa-register', () => ({
  registerSW: mocks.register,
}));

vi.mock('../src/recording/capture-controller', async () => {
  const { readonly, ref } = await import('vue');
  mocks.captureSnapshot = ref({ phase: 'idle' });
  return {
    useBrowserCaptureController: () => ({
      snapshot: readonly(mocks.captureSnapshot),
    }),
  };
});

import { installPwa, pwaStatus } from '../src/pwa';
import PwaUpdateDialog from '../src/components/PwaUpdateDialog.vue';

beforeEach(() => {
  mocks.register.mockReset();
  mocks.update.mockClear();
  mocks.register.mockReturnValue(mocks.update);
  pwaStatus.dismissUpdate();
  mocks.captureSnapshot.value = { phase: 'idle' };
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      },
    },
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    },
  });
});

it('[CAP-003] defers a waiting service-worker update until microphone capture is safely stopped', async () => {
  mocks.captureSnapshot.value = { phase: 'recording' };
  const wrapper = mount(PwaUpdateDialog, { attachTo: document.body });
  installPwa();
  const options = mocks.register.mock.calls[0]?.[0];

  options?.onNeedRefresh();
  await nextTick();
  expect(wrapper.get('dialog').attributes('open')).toBeUndefined();

  mocks.captureSnapshot.value = { phase: 'saved_locally' };
  await nextTick();
  expect(wrapper.get('dialog').attributes('open')).toBe('');

  wrapper.unmount();
});

it('prompts for service-worker updates and reports offline readiness', async () => {
  installPwa();
  const options = mocks.register.mock.calls[0]?.[0];
  expect(options?.immediate).toBe(true);

  options?.onNeedRefresh();
  expect(pwaStatus.needRefresh.value).toBe(true);
  await pwaStatus.applyUpdate();
  expect(mocks.update).toHaveBeenCalledWith(true);

  options?.onOfflineReady();
  expect(pwaStatus.offlineReady.value).toBe(true);
  options?.onRegisterError('failed');
  expect(pwaStatus.error.value?.message).toBe(
    'Service worker registration failed',
  );

  const browserError = new Error('service-worker scope rejected');
  options?.onRegisterError(browserError);
  expect(pwaStatus.error.value).toBe(browserError);
});
