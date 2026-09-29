/**
 * Build config for the DEDICATED preview surface.
 *
 * Separate from `vite.config.ts` because this surface is a different Worker
 * with a different (much smaller) route surface — see src/preview-worker.ts for
 * why sharing the app runtime leaked the SPA shell on the preview hostname.
 *
 * `publicDir: false` is deliberate: the preview origin must not serve the app's
 * static assets (`/static/app.js`), so nothing from `public/` is copied in.
 */
import build from '@hono/vite-build/cloudflare-pages'
import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  plugins: [
    build({
      entry: 'src/preview-worker.ts',
      outputDir: './dist-preview'
    })
  ]
})
