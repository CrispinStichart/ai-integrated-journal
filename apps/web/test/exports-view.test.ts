// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import axe from 'axe-core';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn() }));
vi.mock('../src/auth', () => ({
  useAuthentication: () => ({ status: ref({ csrfToken: 'csrf-token' }) }),
}));
vi.mock('../src/export/api', () => ({
  createPortableExport: mocks.create,
  listPortableExports: mocks.list,
  exportDownloadUrl: (id: string) => `/api/v1/exports/${id}/download`,
}));
vi.mock('../src/stores/ui', () => ({
  useUiStore: () => ({ announce: vi.fn() }),
}));

import ExportsView from '../src/views/ExportsView.vue';

const exportItem = {
  id: '019d2b3c-4000-7000-8000-000000000002',
  status: 'completed',
  manifestSchemaVersion: 1,
  snapshotAt: '2026-08-25T00:00:00.000Z',
  createdAt: '2026-08-25T00:00:00.000Z',
  expiresAt: '2026-08-26T00:00:00.000Z',
  includeAudio: false,
  includeProviderRawResponses: false,
  entityCount: 25,
  fileCount: 8,
  archiveByteSize: '4096',
  archiveSha256: 'a'.repeat(64),
  completedAt: '2026-08-25T00:01:00.000Z',
  downloadAvailable: true,
};

describe('portable export UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([exportItem]);
    mocks.create.mockResolvedValue({
      ...exportItem,
      status: 'queued',
      downloadAvailable: false,
    });
  });

  it('[PORT-003][PORT-006][AC-050] explains archive contents and exposes an accessible completed download', async () => {
    const wrapper = mount(ExportsView, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.text()).toContain('versioned JSON Lines');
    expect(wrapper.text()).toContain('manifest v1');
    expect(wrapper.get('a').attributes('href')).toContain('/download');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    wrapper.unmount();
  });

  it('[MODEL-006][SEC-004] leaves provider payloads unchecked and sends only explicit selections', async () => {
    const wrapper = mount(ExportsView);
    await flushPromises();
    const checkboxes = wrapper.findAll('input[type="checkbox"]');
    expect(
      checkboxes.every(
        (checkbox) => !(checkbox.element as HTMLInputElement).checked,
      ),
    ).toBe(true);
    await wrapper.get('button.btn:not(.btn-ghost)').trigger('click');
    await flushPromises();
    expect(mocks.create).toHaveBeenCalledWith(
      { includeAudio: false, includeProviderRawResponses: false },
      'csrf-token',
      expect.stringMatching(/^export-/),
    );
    wrapper.unmount();
  });
});
