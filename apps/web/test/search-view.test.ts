// @vitest-environment jsdom

import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import axe from 'axe-core';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ search: vi.fn(), processors: vi.fn() }));
vi.mock('../src/search/api', () => ({ lexicalSearch: mocks.search }));
vi.mock('../src/processor/api', () => ({ listProcessors: mocks.processors }));

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
});
