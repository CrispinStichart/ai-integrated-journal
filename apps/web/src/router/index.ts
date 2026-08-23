import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
} from 'vue-router';

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'today',
    component: () => import('../views/JournalDayView.vue'),
    meta: { title: 'Today' },
  },
  {
    path: '/journal/:date(\\d{4}-\\d{2}-\\d{2})',
    name: 'journal-day',
    component: () => import('../views/JournalDayView.vue'),
    props: (route) => ({ date: route.params.date }),
    meta: { title: 'Journal Day' },
  },
  {
    path: '/calendar',
    name: 'calendar',
    component: () => import('../views/CalendarView.vue'),
    meta: { title: 'Calendar' },
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('../views/SectionView.vue'),
    props: {
      description: 'Find source entries and generated artifacts.',
      title: 'Search',
    },
    meta: { title: 'Search' },
  },
  {
    path: '/activity',
    name: 'activity',
    component: () => import('../views/ProcessingActivityView.vue'),
    meta: { title: 'Processing activity' },
  },
  {
    path: '/processors',
    name: 'processors',
    component: () => import('../views/ProcessorsView.vue'),
    meta: { title: 'Processors' },
  },
  {
    path: '/memories',
    name: 'memories',
    component: () => import('../views/SectionView.vue'),
    props: {
      description: 'Review the context you have explicitly approved.',
      title: 'Memories & rules',
    },
    meta: { title: 'Memories & rules' },
  },
  {
    path: '/exports',
    name: 'exports',
    component: () => import('../views/SectionView.vue'),
    props: {
      description: 'Create portable exports and manage local backups.',
      title: 'Exports & backups',
    },
    meta: { title: 'Exports & backups' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SectionView.vue'),
    props: {
      description:
        'Manage privacy, offline storage, and application preferences.',
      title: 'Settings',
    },
    meta: { title: 'Settings' },
  },
];

export function createJournalRouter(base = import.meta.env.BASE_URL) {
  return createRouter({
    history: createWebHistory(base),
    routes,
    scrollBehavior: () => ({ left: 0, top: 0 }),
  });
}
