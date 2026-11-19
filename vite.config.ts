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
    {
      // GitHub Pages cannot send headers; a meta CSP limits where the page can talk to.
      name: 'csp',
      apply: 'build',
      transformIndexHtml: (html: string) =>
        html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${[
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https://*.wikimedia.org https://static.tvmaze.com",
            "connect-src 'self' https://en.wikipedia.org https://www.wikidata.org https://query.wikidata.org https://api.tvmaze.com",
            'frame-src https://www.youtube-nocookie.com',
            "object-src 'none'",
            "base-uri 'self'",
          ].join('; ')}" />`,
        ),
    },
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
                  urlPattern: /^https:\/\/([a-z]+\.wikimedia\.org|static\.tvmaze\.com)\/.*/i,
                  handler: 'CacheFirst',
                  options: {
                    cacheName: 'posters',
                    // Posters are opaque responses, which some browsers count at a large size: on a full quota, drop them, not the app.
                    expiration: { maxEntries: 1500, maxAgeSeconds: 60 * 60 * 24 * 180, purgeOnQuotaError: true },
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
