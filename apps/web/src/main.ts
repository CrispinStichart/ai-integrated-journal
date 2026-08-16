import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { installPwa } from './pwa';
import { createJournalRouter } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: true, retry: 1, staleTime: 30_000 },
  },
});

createApp(App)
  .use(createPinia())
  .use(createJournalRouter())
  .use(VueQueryPlugin, { queryClient })
  .mount('#app');
installPwa();
