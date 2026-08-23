// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  update: vi.fn(async () => undefined),
}));

vi.mock('virtual:pwa-register', () => ({
  registerSW: mocks.register,
}));

import { installPwa, pwaStatus } from '../src/pwa';

beforeEach(() => {
  mocks.register.mockReset();
  mocks.update.mockClear();
  mocks.register.mockReturnValue(mocks.update);
  pwaStatus.dismissUpdate();
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
