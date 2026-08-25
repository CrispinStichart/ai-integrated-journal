// @vitest-environment jsdom

import type { NudgeDayResource } from '@journal/contracts';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import axe from 'axe-core';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  act: vi.fn(),
  getDay: vi.fn(),
  announce: vi.fn(),
}));

vi.mock('@vueuse/core', () => ({
  useEventSource: () => ({ data: ref(null) }),
}));
vi.mock('../src/auth', () => ({
  useAuthentication: () => ({ status: ref({ csrfToken: 'csrf-token' }) }),
}));
vi.mock('../src/journal/api', () => ({
  createUuidV7: () => '019c5b90-0000-7000-8000-000000000099',
}));
vi.mock('../src/nudge/api', () => ({
  actOnNudge: mocks.act,
  getNudgeDay: mocks.getDay,
}));
vi.mock('../src/stores/ui', () => ({
  useUiStore: () => ({ announce: mocks.announce }),
}));

import NudgeDigestCard from '../src/components/NudgeDigestCard.vue';

const NOW = '2026-08-23T20:00:00.000Z';
const DAY_ID = '019c5b90-0000-7000-8000-000000000041';
const DIGEST_ID = '019c5b90-0000-7000-8000-000000000042';

function resource(): NudgeDayResource {
  const evaluations = Array.from({ length: 3 }, (_, index) => ({
    id: `019c5b90-0000-7000-8000-00000000005${index}`,
    journalDayId: DAY_ID,
    journalDate: '2026-08-23',
    processorId: `019c5b90-0000-7000-8000-00000000006${index}`,
    processorVersionId: `019c5b90-0000-7000-8000-00000000007${index}`,
    processorName: `Synthetic requirement ${index + 1}`,
    state: 'pending_user_response' as const,
    revision: 2,
    allowNotApplicable: true,
    prompt: `Answer synthetic requirement ${index + 1}.`,
    supportingRunId: `019c5b90-0000-7000-8000-00000000008${index}`,
    evaluatedAt: NOW,
    updatedAt: NOW,
  }));
  const first = evaluations[0];
  if (first === undefined) throw new Error('Evaluation fixture missing.');
  return {
    journalDate: '2026-08-23',
    evaluations: [
      ...evaluations,
      {
        ...first,
        id: '019c5b90-0000-7000-8000-000000000090',
        processorId: '019c5b90-0000-7000-8000-000000000091',
        processorVersionId: '019c5b90-0000-7000-8000-000000000092',
        processorName: 'Failed technical processor',
        state: 'failed',
      },
    ],
    digest: {
      id: DIGEST_ID,
      journalDayId: DAY_ID,
      journalDate: '2026-08-23',
      status: 'queued',
      revision: 1,
      scheduledAt: '2026-08-24T08:00:00.000Z',
      items: evaluations.map((evaluation, index) => ({
        id: `019c5b90-0000-7000-8000-00000000009${index + 3}`,
        evaluationId: evaluation.id,
        processorName: evaluation.processorName,
        prompt: evaluation.prompt,
        allowNotApplicable: true,
        state: 'pending_user_response' as const,
      })),
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function mountCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    wrapper: mount(NudgeDigestCard, {
      props: { journalDate: '2026-08-23' },
      attachTo: document.body,
      global: { plugins: [[VueQueryPlugin, { queryClient }]] },
    }),
  };
}

describe('required-information digest UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDay.mockResolvedValue(resource());
    const acted = resource();
    if (acted.digest === undefined) throw new Error('Digest fixture missing.');
    mocks.act.mockResolvedValue({
      ...acted,
      digest: { ...acted.digest, status: 'resolved', revision: 2 },
    });
  });

  it('[NUDGE-002][NUDGE-005][NUDGE-007][AC-042][AC-043] renders one accessible digest for three items while identifying failure as technical', async () => {
    const { wrapper, queryClient } = mountCard();
    await flushPromises();
    expect(wrapper.findAll('form')).toHaveLength(3);
    expect(wrapper.text()).toContain('Queued until quiet hours end');
    expect(wrapper.text()).toContain(
      'Failed technical processor processing failed',
    );
    expect(wrapper.text()).toContain(
      'technical processing failure, not missing journal information',
    );
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    wrapper.unmount();
    queryClient.clear();
  });

  it('[DATA-013][NUDGE-006] saves an answer as a linked nudge response and exposes defer, dismiss, and not-applicable actions', async () => {
    const { wrapper, queryClient } = mountCard();
    await flushPromises();
    const textarea = wrapper.get('textarea');
    await textarea.setValue('Synthetic answer.');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(mocks.act).toHaveBeenCalledWith(
      expect.objectContaining({
        digestId: DIGEST_ID,
        digestRevision: 1,
        action: expect.objectContaining({
          action: 'answer',
          text: 'Synthetic answer.',
        }),
      }),
    );
    expect(wrapper.text()).toContain('Remind me in one hour');
    expect(wrapper.text()).toContain('Dismiss for this day');
    expect(wrapper.text()).toContain('Not applicable');
    wrapper.unmount();
    queryClient.clear();
  });
});
