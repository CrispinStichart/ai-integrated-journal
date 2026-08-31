import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => ({
  plugins: [
    vue(),
    tailwindcss(),
    VitePWA({
      devOptions: { enabled: command === 'serve' },
      injectRegister: false,
      manifest: {
        name: 'Journal',
        short_name: 'Journal',
        description:
          'A private, local-first journal with optional AI assistance.',
        display: 'standalone',
        start_url: '/',
        theme_color: '#f4f0e8',
        background_color: '#f4f0e8',
        icons: [
          {
            src: '/pwa-192x192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/pwa-512x512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      registerType: 'prompt',
      selfDestroying: command === 'serve',
      workbox: {
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'journal-navigation',
              networkTimeoutSeconds: 3,
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
}));
