// @vitest-environment jsdom

import type { MemoryResource } from '@journal/contracts';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import axe from 'axe-core';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn(), mutate: vi.fn() }));
vi.mock('../src/auth', () => ({
  useAuthentication: () => ({ status: ref({ csrfToken: 'csrf-token' }) }),
}));
vi.mock('../src/journal/api', () => ({
  createUuidV7: () => '019c5b90-0000-7000-8000-000000000099',
}));
vi.mock('../src/memory/api', () => ({
  listMemories: mocks.list,
  mutateMemory: mocks.mutate,
}));

import MemoriesView from '../src/views/MemoriesView.vue';

const MEMORY_ID = '019c5b90-0000-7000-8000-000000000021';
const REVISION_ID = '019c5b90-0000-7000-8000-000000000022';
const NOW = '2026-08-23T20:00:00.000Z';
const memory: MemoryResource = {
  id: MEMORY_ID,
  revision: 2,
  currentRevision: {
    id: REVISION_ID,
    revision: 2,
    type: 'known_entity',
    content: 'Nicolette is a known name.',
    rationale: 'Approved correction.',
    creator: 'user',
    approvalState: 'approved',
    scope: { kind: 'global_transcription' },
    enabled: true,
    createdAt: NOW,
  },
  history: [
    {
      id: REVISION_ID,
      revision: 2,
      type: 'known_entity',
      content: 'Nicolette is a known name.',
      rationale: 'Approved correction.',
      creator: 'user',
      approvalState: 'approved',
      scope: { kind: 'global_transcription' },
      enabled: true,
      createdAt: NOW,
    },
  ],
  historyTruncated: false,
  createdAt: NOW,
  updatedAt: NOW,
};

function mountView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = mount(MemoriesView, {
    attachTo: document.body,
    global: { plugins: [[VueQueryPlugin, { queryClient }]] },
  });
  return { wrapper, queryClient };
}

describe('memory management UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([memory]);
    mocks.mutate.mockResolvedValue(memory);
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
  });

  it('[MEM-004][MEM-005][AC-031] exposes searchable content, scope, creator, status, and revision history accessibly', async () => {
    const { wrapper, queryClient } = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('Nicolette is a known name.');
    expect(wrapper.text()).toContain('global transcription');
    expect(wrapper.text()).toContain('Creator: user');
    expect(wrapper.text()).toContain('Revision history');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    queryClient.clear();
    wrapper.unmount();
  });

  it('[MEM-004][AC-031] supports enable/disable, immutable editing, and warned deletion controls', async () => {
    const { wrapper, queryClient } = mountView();
    await flushPromises();
    await wrapper.get('input.toggle').trigger('change');
    await flushPromises();
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: MEMORY_ID,
        revision: 2,
        mutation: { operation: 'disable' },
      }),
    );

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Edit')
      ?.trigger('click');
    const editor = wrapper.get('#memory-editor');
    await editor
      .findAll('textarea')[0]
      ?.setValue('Nicolette is a known person.');
    await editor
      .findAll('button')
      .find((button) => button.text() === 'Save revision')
      ?.trigger('click');
    await flushPromises();
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: expect.objectContaining({
          operation: 'edit',
          memory: expect.objectContaining({
            content: 'Nicolette is a known person.',
          }),
        }),
      }),
    );

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Delete')
      ?.trigger('click');
    expect(wrapper.get('#memory-delete').text()).toContain(
      'removes the memory from future processing',
    );
    queryClient.clear();
    wrapper.unmount();
  });
});
