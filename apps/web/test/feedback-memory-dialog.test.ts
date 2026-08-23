// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../src/auth', () => ({
  useAuthentication: () => ({ status: ref({ csrfToken: 'csrf-token' }) }),
}));
vi.mock('../src/journal/api', () => ({
  createUuidV7: () => '019c5b90-0000-7000-8000-000000000099',
}));
vi.mock('../src/memory/api', () => ({ createFeedback: mocks.create }));

import FeedbackMemoryDialog from '../src/components/FeedbackMemoryDialog.vue';

const TARGET_ID = '019c5b90-0000-7000-8000-000000000023';

describe('universal feedback scope UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
  });

  it('[MEM-001][MEM-002][FB-001][FB-004][AC-030] defaults to occurrence-only and creates no hidden memory', async () => {
    mocks.create.mockResolvedValue({
      feedback: { id: TARGET_ID },
      idempotency: { key: 'key', replayed: false },
    });
    const wrapper = mount(FeedbackMemoryDialog, {
      props: { target: { kind: 'transcript_revision', id: TARGET_ID } },
      attachTo: document.body,
    });
    await wrapper.get('button').trigger('click');
    expect(wrapper.text()).toContain('No persistent rule is created');
    await wrapper
      .get('input[data-feedback-message]')
      .setValue('Only this occurrence is wrong.');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Save feedback')
      ?.trigger('click');
    await flushPromises();
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        feedback: {
          mode: 'occurrence_only',
          target: { kind: 'transcript_revision', id: TARGET_ID },
          message: 'Only this occurrence is wrong.',
        },
      }),
    );
    wrapper.unmount();
  });

  it('[MEM-001][FB-002][FB-003] requires an explicit remember choice and approval disclosure', async () => {
    mocks.create.mockResolvedValue({
      feedback: { id: TARGET_ID },
      memory: { id: TARGET_ID },
      idempotency: { key: 'key', replayed: false },
    });
    const wrapper = mount(FeedbackMemoryDialog, {
      props: { target: { kind: 'artifact_version', id: TARGET_ID } },
      attachTo: document.body,
    });
    await wrapper.get('button').trigger('click');
    await wrapper.get('input[value="correct_and_remember"]').setValue(true);
    expect(wrapper.text()).toContain('explicitly approves this scoped memory');
    await wrapper
      .get('input[data-feedback-message]')
      .setValue('Remember the preferred name.');
    await wrapper
      .get('input[data-memory-content]')
      .setValue('Nicolette is the preferred spelling.');
    await wrapper
      .get('input[data-memory-rationale]')
      .setValue('Explicit correction.');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Save feedback')
      ?.trigger('click');
    await flushPromises();
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        feedback: expect.objectContaining({
          mode: 'correct_and_remember',
          approval: 'approved',
          memory: expect.objectContaining({
            type: 'correction_rule',
            scope: { kind: 'global_transcription' },
          }),
        }),
      }),
    );
    wrapper.unmount();
  });
});
