import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // Relative asset paths so the built app works from any static path,
  // including a GitHub Pages project subdirectory.
  base: './',
  build: {
    rollupOptions: {
      output: {
        // A stable name so the precache can exclude it by glob. Left to hash
        // its own name, the Firebase SDK's chunks are unmatchable and end up
        // precached — 700 KB every install pays for, signed in or not.
        manualChunks(id) {
          if (id.includes('node_modules/@firebase') || id.includes('node_modules/firebase')) {
            return 'firebase'
          }
          return undefined
        },
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Construction Expenses',
        short_name: 'Construction',
        description:
          'Track construction spending across properties: which fund source paid, and whom it was paid to.',
        theme_color: '#1f6feb',
        background_color: '#f6f7f9',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Everything is local, so precaching the whole shell is the entire
        // offline story — there are no network calls to fall back on.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // Without this, `**/*.js` sweeps the 3.8 MB OCR core into the precache
        // and every install pays for a feature most sessions never touch.
        // Both are large, optional and used by a minority of sessions: fetched
        // on first use and cached by the runtime rules below instead.
        globIgnores: ['**/ocr/**', '**/firebase-*.js'],
        // The OCR engine and model are ~6 MB and only needed by one optional
        // feature, so they are cached on first use rather than precached.
        runtimeCaching: [
          {
            urlPattern: /\/assets\/firebase-[A-Za-z0-9_-]+\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'firebase-sdk',
              expiration: { maxEntries: 4 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/ocr\/.*\.(?:wasm|gz|js)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-engine',
              expiration: { maxEntries: 8 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
})
