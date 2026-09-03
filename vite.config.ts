import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // Relative asset paths so the built app works from any static path,
  // including a GitHub Pages project subdirectory.
  base: './',
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
        globIgnores: ['**/ocr/**'],
        // The OCR engine and model are ~6 MB and only needed by one optional
        // feature, so they are cached on first use rather than precached.
        runtimeCaching: [
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
