// @vitest-environment jsdom

import type {
  CreateContributionRequest,
  JournalDayView as JournalDayResource,
} from '@journal/contracts';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, readonly, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createUuidV7: vi.fn(),
  offline: undefined as unknown as ReturnType<typeof createOfflineMock>,
}));

vi.mock('../src/auth', () => ({
  useAuthentication: () => ({
    status: ref({
      ownerId: '018f0000-0000-7000-8000-000000000001',
      csrfToken: 'csrf-token',
    }),
  }),
}));

vi.mock('../src/journal/api', () => ({
  createUuidV7: () => mocks.createUuidV7(),
  listContributionRevisions: vi.fn(),
  moveContribution: vi.fn(),
  moveContributionAtRevision: vi.fn(),
  setContributionDeleted: vi.fn(),
}));

vi.mock('../src/recording/capture-controller', async () => {
  const { readonly, ref } = await import('vue');
  const snapshot = readonly(ref({ phase: 'idle', storageState: 'available' }));
  return {
    useBrowserCaptureController: () => ({
      snapshot,
      start: vi.fn(),
      stop: vi.fn(),
    }),
  };
});

vi.mock('../src/recording/sync-controller', async () => {
  const { readonly, ref } = await import('vue');
  const recordings = readonly(ref([]));
  return {
    useRecordingSyncController: () => ({
      recordings,
      initialize: vi.fn(),
      refresh: vi.fn(),
      resume: vi.fn(),
      retry: vi.fn(),
      move: vi.fn(),
    }),
  };
});

vi.mock('../src/recording/api', () => ({
  recordingAudioUrl: (id: string) => `/api/v1/recordings/${id}/audio`,
  retryRecordingFinalization: vi.fn(),
}));

vi.mock('../src/journal/offline', () => ({
  useOfflineJournal: () => mocks.offline,
}));

vi.mock('../src/stores/ui', () => ({
  useUiStore: () => ({ announce: vi.fn() }),
}));

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() }),
}));

import JournalDayView from '../src/views/JournalDayView.vue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createOfflineMock() {
  const pendingCount = ref(0);
  let pending: Array<{
    kind: 'create';
    input: CreateContributionRequest;
    idempotencyKey: string;
  }> = [];
  let savedDay: JournalDayResource | undefined;
  const serverRefresh = deferred<JournalDayResource | undefined>();
  const readDay = vi
    .fn<() => Promise<JournalDayResource | undefined>>()
    .mockResolvedValueOnce(undefined)
    .mockImplementation(() => serverRefresh.promise);

  return {
    configured: readonly(ref(true)),
    unlocked: readonly(ref(true)),
    pendingCount: readonly(pendingCount),
    cacheBytes: readonly(ref(0)),
    cacheDays: readonly(ref(0)),
    lastReadFromCache: readonly(ref(false)),
    conflict: readonly(ref(undefined)),
    readyForLocalCapture: readonly(ref(true)),
    initialize: vi.fn().mockResolvedValue(undefined),
    pendingForDay: vi.fn(async () => pending),
    readDay,
    enqueueCreate: vi.fn(
      async (input: CreateContributionRequest, idempotencyKey: string) => {
        pending = [{ kind: 'create', input, idempotencyKey }];
        pendingCount.value = 1;
      },
    ),
    replay: vi.fn(async () => {
      const mutation = pending[0];
      if (mutation === undefined) return;
      const input = mutation.input;
      savedDay = {
        id: input.proposedJournalDayId,
        journalDate: input.journalDate,
        createdAt: input.capturedAt,
        contributions: [
          {
            id: input.contributionId,
            journalDayId: input.proposedJournalDayId,
            journalDate: input.journalDate,
            authorId: '018f0000-0000-7000-8000-000000000001',
            sourceType: input.sourceType,
            capturedAt: input.capturedAt,
            capturedTimezone: input.capturedTimezone,
            journalTimezone: input.journalTimezone,
            journalDateAssignment: input.journalDateAssignment,
            currentRevision: {
              id: input.revisionId,
              contributionId: input.contributionId,
              revision: 1,
              text: input.text,
              authority: 'manual',
              authorId: '018f0000-0000-7000-8000-000000000001',
              createdAt: input.capturedAt,
            },
          },
        ],
      };
      pending = [];
      pendingCount.value = 0;
    }),
    resolveServerRefresh: () => serverRefresh.resolve(savedDay),
    setup: vi.fn(),
    unlock: vi.fn(),
    resolveConflict: vi.fn(),
    clearReadCache: vi.fn(),
  };
}

describe('Journal Day optimistic creation (AC-003)', () => {
  beforeEach(() => {
    mocks.offline = createOfflineMock();
    let sequence = 2;
    mocks.createUuidV7.mockImplementation(() => {
      sequence += 1;
      return `018f0000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
    });
  });

  it('keeps a newly added contribution visible while the server day refreshes', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const Host = defineComponent({
      components: { JournalDayView },
      template: '<Suspense><JournalDayView date="2026-08-16" /></Suspense>',
    });
    const wrapper = mount(Host, {
      global: {
        plugins: [[VueQueryPlugin, { queryClient }]],
        stubs: { RouterLink: { template: '<a><slot /></a>' } },
      },
    });
    await flushPromises();

    await wrapper.get('textarea').setValue('A note that should not flash');
    const submitted = wrapper
      .get('form[aria-label="Add a typed contribution"]')
      .trigger('submit');

    await vi.waitFor(() => {
      expect(mocks.offline.readDay).toHaveBeenCalledTimes(2);
      expect(wrapper.text()).toContain('A note that should not flash');
    });
    await nextTick();
    await nextTick();
    expect(wrapper.text()).toContain('A note that should not flash');

    mocks.offline.resolveServerRefresh();
    await submitted;
    await flushPromises();
    expect(wrapper.text()).toContain('A note that should not flash');

    queryClient.clear();
    wrapper.unmount();
  });
});
