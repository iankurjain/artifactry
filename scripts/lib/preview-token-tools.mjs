/**
 * Preview-token minting helper for the browser security suite.
 *
 * Negative tests need tokens that the application cannot produce on demand:
 * an expired one, and one signed for a foreign framing origin. Both require the
 * signing secret, so this bundles the real `src/lib/htmlpreview.ts` and calls
 * the real `mintPreviewToken` — the suite therefore tests the production
 * signing/verification code rather than a reimplementation of it.
 *
 * The secret is read from `.dev.vars` at runtime. It is never a literal in this
 * file, never printed, and never returned to a caller that could log it.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = process.cwd()

/** Read the local development signing secret without ever surfacing it. */
export function loadDevSecret() {
  const fromEnv = process.env.PREVIEW_TOKEN_SECRET
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()

  const devVars = path.join(ROOT, '.dev.vars')
  if (!fs.existsSync(devVars)) {
    throw new Error('No PREVIEW_TOKEN_SECRET in env and no .dev.vars to read it from')
  }
  for (const line of fs.readFileSync(devVars, 'utf8').split('\n')) {
    const match = /^\s*PREVIEW_TOKEN_SECRET\s*=\s*(.*)$/.exec(line)
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, '')
      if (value) return value
    }
  }
  throw new Error('PREVIEW_TOKEN_SECRET not present in .dev.vars')
}

/** Local development preview origin. */
export function loadDevPreviewOrigin() {
  const fromEnv = process.env.PREVIEW_ORIGIN
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()

  const devVars = path.join(ROOT, '.dev.vars')
  if (fs.existsSync(devVars)) {
    for (const line of fs.readFileSync(devVars, 'utf8').split('\n')) {
      const match = /^\s*PREVIEW_ORIGIN\s*=\s*(.*)$/.exec(line)
      if (match && match[1].trim()) return match[1].trim().replace(/^["']|["']$/g, '')
    }
  }
  return 'http://preview.localhost:3000'
}

/**
 * Bundle a project TypeScript module to ESM and import it, so the suite drives
 * the same code the Worker runs.
 */
export async function loadModule(relPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-bundle-'))
  const outfile = path.join(tmpDir, 'bundle.mjs')

  await esbuild.build({
    entryPoints: [path.join(ROOT, relPath)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent'
  })

  return import(pathToFileURL(outfile).href)
}

/**
 * Build the minting surface the suite needs.
 *
 * `mint(overrides)` signs a token with the real implementation; the overrides
 * exist only to manufacture the states the app never emits itself.
 */
export async function loadTokenTools() {
  const mod = await loadModule('src/lib/htmlpreview.ts')
  const secret = loadDevSecret()

  return {
    mintPreviewToken: mod.mintPreviewToken,
    verifyPreviewToken: mod.verifyPreviewToken,
    previewDocumentCsp: mod.previewDocumentCsp,
    env: { PREVIEW_TOKEN_SECRET: secret, PREVIEW_ORIGIN: loadDevPreviewOrigin() }
  }
}
