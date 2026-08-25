// @vitest-environment jsdom

import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import axe from 'axe-core';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  ask: vi.fn(),
  getAnswer: vi.fn(),
  processors: vi.fn(),
}));
vi.mock('../src/search/api', () => ({
  lexicalSearch: mocks.search,
  askGroundedAnswer: mocks.ask,
  getGroundedAnswer: mocks.getAnswer,
}));
vi.mock('../src/processor/api', () => ({ listProcessors: mocks.processors }));
vi.mock('../src/auth', () => ({
  useAuthentication: () => ({
    status: { value: { csrfToken: 'csrf-fixture' } },
  }),
}));

import SearchView from '../src/views/SearchView.vue';

const result = {
  fragmentId: '019c5b90-0000-7000-8000-000000000041',
  sourceKind: 'contribution_revision' as const,
  layer: 'typed_text' as const,
  sourceId: '019c5b90-0000-7000-8000-000000000042',
  sourceRevisionId: '019c5b90-0000-7000-8000-000000000041',
  sourceRevision: 2,
  journalDate: '2026-08-25',
  contributionId: '019c5b90-0000-7000-8000-000000000042',
  contributionType: 'typed_text' as const,
  authority: 'manual' as const,
  score: 0.5,
  retrievalSignals: { lexicalRank: 2, semanticRank: 1 },
  snippet: [
    { text: 'Safe before ', highlighted: false },
    { text: '<img src=x onerror=alert(1)>', highlighted: true },
  ],
  href: '/journal/2026-08-25?source=contribution_revision&revision=019c5b90-0000-7000-8000-000000000041',
};

const groundedAnswer = {
  id: '019c5b90-0000-7000-8000-000000000043',
  question: 'What did I do this morning?',
  status: 'succeeded' as const,
  retrieval: {
    requestedMode: 'hybrid' as const,
    effectiveMode: 'hybrid' as const,
  },
  synthesis: 'You took a morning walk.',
  citations: [
    {
      citationId: `cite_${'a'.repeat(32)}`,
      sourceKind: result.sourceKind,
      layer: result.layer,
      sourceId: result.sourceId,
      sourceRevisionId: result.sourceRevisionId,
      sourceRevision: result.sourceRevision,
      journalDate: result.journalDate,
      authority: result.authority,
      retrievedQuote: '<script>alert("quoted")</script> Morning walk',
      evidence: {
        normalization: 'NFC_LF_V1' as const,
        offsetUnit: 'utf16_code_unit' as const,
        startUtf16: 0,
        endUtf16: 45,
        quoteSha256: 'b'.repeat(64),
      },
      href: result.href,
    },
  ],
  requestedAt: '2026-08-25T04:00:00.000Z',
  completedAt: '2026-08-25T04:00:01.000Z',
};

async function mountView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/search', component: SearchView },
      { path: '/journal/:date', component: { template: '<div />' } },
    ],
  });
  await router.push('/search');
  await router.isReady();
  const wrapper = mount(SearchView, {
    attachTo: document.body,
    global: { plugins: [router, [VueQueryPlugin, { queryClient }]] },
  });
  return { wrapper, queryClient };
}

describe('lexical search UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processors.mockResolvedValue([]);
    mocks.search.mockResolvedValue({
      items: [result],
      retrieval: {
        requestedMode: 'hybrid',
        effectiveMode: 'hybrid',
        cohort: {
          providerId: 'fixture',
          modelId: 'semantic-v1',
          modelVersion: '1',
          dimension: 4,
          configurationFingerprint: 'a'.repeat(64),
        },
      },
      page: { hasMore: false },
    });
    mocks.ask.mockResolvedValue(groundedAnswer);
    mocks.getAnswer.mockResolvedValue(groundedAnswer);
  });

  it('[SEARCH-001][SEARCH-003][SEARCH-004][SEARCH-005] chooses layers, renders inert quoted source snippets, and links exact revisions accessibly', async () => {
    const { wrapper, queryClient } = await mountView();
    await wrapper.get('input[type="search"]').setValue('morning');
    await wrapper.get('input[type="date"]').setValue('2026-08-01');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'morning',
        mode: 'hybrid',
        dateFrom: '2026-08-01',
        layers: expect.arrayContaining(['typed_text', 'corrected']),
      }),
      undefined,
    );
    expect(wrapper.text()).toContain('Retrieved sources and results');
    expect(wrapper.text()).toContain('Meaning match');
    expect(wrapper.text()).toContain('Word match');
    expect(wrapper.text()).toContain('fixture / semantic-v1');
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
    expect(wrapper.find('blockquote img').exists()).toBe(false);
    expect(wrapper.get('mark').text()).toBe('<img src=x onerror=alert(1)>');
    expect(wrapper.get('a.link').attributes('href')).toContain(
      'revision=019c5b90-0000-7000-8000-000000000041',
    );
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    queryClient.clear();
    wrapper.unmount();
  });

  it('[ARCH-005][SEARCH-002] explains provider fallback while preserving lexical results', async () => {
    mocks.search.mockResolvedValueOnce({
      items: [result],
      retrieval: {
        requestedMode: 'semantic',
        effectiveMode: 'lexical',
        fallbackReason: 'provider_unavailable',
      },
      page: { hasMore: false },
    });
    const { wrapper, queryClient } = await mountView();
    await wrapper
      .get('select[aria-label="Search method"]')
      .setValue('semantic');
    await wrapper.get('input[type="search"]').setValue('morning');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain(
      'Semantic retrieval is not configured',
    );
    expect(wrapper.text()).toContain('Safe before');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    queryClient.clear();
    wrapper.unmount();
  });

  it('[SEARCH-001] requires an explicit query and at least one selected layer', async () => {
    const { wrapper, queryClient } = await mountView();
    await wrapper.get('form').trigger('submit');
    expect(wrapper.get('[role="alert"]').text()).toContain('Enter words');
    for (const checkbox of wrapper.findAll('input[type="checkbox"]')) {
      if ((checkbox.element as HTMLInputElement).checked)
        await checkbox.setValue(false);
    }
    await wrapper.get('input[type="search"]').setValue('morning');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.get('[role="alert"]').text()).toContain(
      'Choose at least one',
    );
    expect(mocks.search).not.toHaveBeenCalled();
    queryClient.clear();
    wrapper.unmount();
  });

  it('[SEARCH-003][SEARCH-004][SEARCH-007][SEC-009] separates synthesis from inert precise citations accessibly', async () => {
    const { wrapper, queryClient } = await mountView();
    await wrapper
      .get('input[type="search"]')
      .setValue('What did I do this morning?');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Answer from evidence')
      ?.trigger('click');
    await flushPromises();
    expect(mocks.ask.mock.calls[0]?.[0]).toEqual({
      csrfToken: 'csrf-fixture',
      request: expect.objectContaining({
        question: 'What did I do this morning?',
        mode: 'hybrid',
      }),
    });
    expect(wrapper.text()).toContain('AI-generated synthesis');
    expect(wrapper.text()).toContain('You took a morning walk.');
    expect(wrapper.text()).toContain('Retrieved quote');
    expect(wrapper.text()).toContain('<script>alert("quoted")</script>');
    expect(wrapper.find('blockquote script').exists()).toBe(false);
    expect(wrapper.get('a.link').attributes('href')).toContain(
      `revision=${result.sourceRevisionId}`,
    );
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    queryClient.clear();
    wrapper.unmount();
  });

  it('[SEARCH-007][STATE-003] reports insufficient support separately from generation failure', async () => {
    mocks.ask.mockResolvedValueOnce({
      ...groundedAnswer,
      status: 'insufficient_support',
      synthesis: undefined,
      citations: [],
    });
    mocks.getAnswer.mockResolvedValueOnce({
      ...groundedAnswer,
      status: 'insufficient_support',
      synthesis: undefined,
      citations: [],
    });
    const { wrapper, queryClient } = await mountView();
    await wrapper.get('input[type="search"]').setValue('Unsupported question');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Answer from evidence')
      ?.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Insufficient supporting evidence');
    expect(wrapper.text()).toContain(
      'No unsupported recollection was generated',
    );
    expect(wrapper.text()).not.toContain('processing failure');
    queryClient.clear();
    wrapper.unmount();
  });
});
