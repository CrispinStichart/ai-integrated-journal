// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { createJournalRouter, routes } from '../src/router';
import { useUiStore } from '../src/stores/ui';

beforeEach(() => {
  setActivePinia(createPinia());
  window.scrollTo = () => undefined;
});

describe('frontend application foundations', () => {
  it('defines every product area as a lazy route', async () => {
    expect(routes.map((route) => route.path)).toEqual([
      '/',
      '/journal/:date(\\d{4}-\\d{2}-\\d{2})',
      '/calendar',
      '/search',
      '/activity',
      '/processors',
      '/memories',
      '/exports',
      '/settings',
    ]);
    expect(routes.every((route) => typeof route.component === 'function')).toBe(
      true,
    );

    const loadedRoutes = await Promise.all(
      routes.map(async (route) => {
        const load = route.component as () => Promise<{ default: unknown }>;
        return load();
      }),
    );
    expect(loadedRoutes.every((route) => route.default !== undefined)).toBe(
      true,
    );

    const journalDayRoute = routes.find(
      (route) => route.name === 'journal-day',
    );
    if (typeof journalDayRoute?.props !== 'function') {
      throw new Error('journal-day route must derive props from route params');
    }
    expect(
      journalDayRoute.props({ params: { date: '2026-08-23' } } as never),
    ).toEqual({ date: '2026-08-23' });

    const router = createJournalRouter('/');
    await router.push('/settings');
    await router.isReady();
    expect(router.currentRoute.value.meta.title).toBe('Settings');
  }, 15_000);

  it('keeps only session-wide UI workflow state in Pinia', async () => {
    const ui = useUiStore();
    ui.navigationOpen = true;
    ui.closeNavigation();
    expect(ui.navigationOpen).toBe(false);

    ui.announce('Calendar page loaded');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(ui.liveMessage).toBe('Calendar page loaded');
  });
});
