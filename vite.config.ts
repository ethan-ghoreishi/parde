import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

export default defineConfig(({ command, mode, isPreview }) => ({
  // GitHub Pages project site. IndexedDB belongs to this origin+path: never move it casually.
  base: command === 'build' || isPreview ? '/parde/' : '/',
  server: { port: 5391, strictPort: true },
  preview: { port: 4391, strictPort: true },
  define: {
    __APP_VERSION__: JSON.stringify(
      process.env.GITHUB_SHA ? `${pkg.version}+${process.env.GITHUB_SHA.slice(0, 7)}` : pkg.version,
    ),
  },
  plugins: [
    svelte(),
    ...(mode === 'test'
      ? []
      : [
          VitePWA({
            registerType: 'autoUpdate',
            pwaAssets: { preset: 'minimal-2023', image: 'public/logo.svg' },
            manifest: {
              name: 'Parde',
              short_name: 'Parde',
              description: 'A private film and TV companion.',
              lang: 'en-GB',
              theme_color: '#14110f',
              background_color: '#14110f',
              display: 'standalone',
              categories: ['entertainment', 'lifestyle'],
            },
            workbox: {
              globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
              navigateFallback: 'index.html',
              runtimeCaching: [
                {
                  // Posters: cache-first so the library looks right offline.
                  urlPattern: /^https:\/\/(upload\.wikimedia\.org|static\.tvmaze\.com)\/.*/i,
                  handler: 'CacheFirst',
                  options: {
                    cacheName: 'posters',
                    expiration: { maxEntries: 1500, maxAgeSeconds: 60 * 60 * 24 * 180 },
                    cacheableResponse: { statuses: [0, 200] },
                  },
                },
              ],
            },
          }),
        ]),
  ],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
}));
