/**
 * Production surface validation (real domains, real browser).
 *
 * This is the deploy-time counterpart to scripts/test-preview-security.mjs. That
 * suite proves the isolation model against a local dev pair; this one proves the
 * deployed pair behaves the same way, and that the two Pages projects stayed
 * separate.
 *
 * WHAT IT COVERS WITHOUT A SESSION
 * Everything about the split surfaces: which hostname serves the shell, which
 * refuses to, cookie emission, refusal behaviour for a bad or foreign-hostname
 * token, and the security headers. None of that needs a login.
 *
 * WHAT IT CANNOT COVER, AND WHY THAT IS NOT A PASS
 * The authenticated half of the checklist (Safe Preview renders HTML/CSS only,
 * Interactive executes inline JS, no parent-DOM or top-navigation escape,
 * fetch/XHR/WebSocket egress blocked, expired/tampered/revoked token handling)
 * needs a signed-in owner to upload a probe artifact and enable Interactive.
 * A production OTP is emailed, not returned, so this script cannot log in on its
 * own. Those checks are reported as BLOCKED, never as passing — a skipped
 * security assertion must not read as a verified one.
 *
 * Usage:
 *   node scripts/test-production.mjs
 *   APP_ORIGIN=https://artifactry.app PREVIEW_ORIGIN=https://preview.artifactry.app node scripts/test-production.mjs
 */

import { chromium } from 'playwright'

const APP = (process.env.PROD_APP_ORIGIN ?? 'https://artifact-library.pages.dev').replace(/\/$/, '')
const PREVIEW = (process.env.PROD_PREVIEW_ORIGIN ?? 'https://artifactry-preview.pages.dev').replace(/\/$/, '')
const EXPECTED_APP = 'https://artifactry.app'
const EXPECTED_PREVIEW = 'https://preview.artifactry.app'

let pass = 0
let fail = 0
let blocked = 0
const failures = []

function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`  \u2713 ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  \u2717 ${name}${detail ? `  \u2014 ${detail}` : ''}`)
  }
}

function block(name, why) {
  blocked++
  console.log(`  \u25CB BLOCKED: ${name}  \u2014 ${why}`)
}

function section(t) {
  console.log(`\n=== ${t} ===`)
}

const SHELL_MARKERS = ['id="app"', 'boot-data', '/static/app.js', 'bootdata']

function hasShell(body) {
  return SHELL_MARKERS.some((m) => body.includes(m))
}

async function get(url, opts = {}) {
  const res = await fetch(url, { redirect: 'manual', ...opts })
  const body = await res.text().catch(() => '')
  return { res, body, status: res.status }
}

async function main() {
  console.log(`APP     = ${APP}`)
  console.log(`PREVIEW = ${PREVIEW}`)
  console.log(`target app origin     = ${EXPECTED_APP}`)
  console.log(`target preview origin = ${EXPECTED_PREVIEW}`)

  // ---------------------------------------------------------------
  // 1. The application surface
  // ---------------------------------------------------------------
  section('Application surface')
  {
    const root = await get(`${APP}/`)
    check('app origin serves the SPA shell', root.status === 200 && hasShell(root.body), `status=${root.status}`)

    const health = await get(`${APP}/api/health`)
    check('app origin /api/health is 200', health.status === 200, `status=${health.status}`)

    const p = await get(`${APP}/p/not-a-token`)
    check('app origin refuses /p/:token with 404', p.status === 404, `status=${p.status}`)
    check('app origin /p/ 404 carries NO shell bytes', !hasShell(p.body), `${p.body.length} bytes`)

    const h = root.res.headers
    check('app sends HSTS', !!h.get('strict-transport-security'), String(h.get('strict-transport-security')))
    check('app sends X-Content-Type-Options', h.get('x-content-type-options') === 'nosniff')
    check('app sends Referrer-Policy', !!h.get('referrer-policy'))
  }

  // ---------------------------------------------------------------
  // 2. The preview surface must be minimal and shell-free
  // ---------------------------------------------------------------
  section('Preview surface (must never serve the application)')
  {
    for (const path of ['/', '/library', '/static/app.js', '/api/hello', '/p/not-a-token']) {
      const r = await get(`${PREVIEW}${path}`)
      check(
        `preview ${path} returns no application shell`,
        !hasShell(r.body),
        `status=${r.status} bytes=${r.body.length}`
      )
    }

    const health = await get(`${PREVIEW}/api/health`)
    check('preview /api/health responds 200', health.status === 200, `status=${health.status}`)
    check(
      'preview responses are tagged as the dedicated surface',
      health.res.headers.get('x-preview-surface') === 'dedicated',
      String(health.res.headers.get('x-preview-surface'))
    )
  }

  // ---------------------------------------------------------------
  // 3. Cookies: the preview origin must never set one
  // ---------------------------------------------------------------
  section('Cookie isolation')
  {
    for (const path of ['/', '/library', '/api/health', '/p/not-a-token']) {
      const r = await get(`${PREVIEW}${path}`)
      const sc = r.res.headers.getSetCookie ? r.res.headers.getSetCookie() : []
      check(`preview ${path} sends no Set-Cookie`, sc.length === 0, JSON.stringify(sc).slice(0, 120))
    }
  }

  // ---------------------------------------------------------------
  // 4. Refusal behaviour and the hostname pin
  // ---------------------------------------------------------------
  section('Token refusal and hostname pin')
  {
    const bad = await get(`${PREVIEW}/p/not-a-token`)
    check(
      'a malformed token is refused (401/404), not served',
      bad.status === 401 || bad.status === 404,
      `status=${bad.status}`
    )
    const csp = bad.res.headers.get('content-security-policy') ?? ''
    check('refusal page locks the document down (default-src none)', /default-src 'none'/.test(csp), csp.slice(0, 90))
    check('refusal page permits no framer', /frame-ancestors 'none'/.test(csp), csp.slice(0, 90))
    check('refusal page is not cached', /no-store/.test(bad.res.headers.get('cache-control') ?? ''))

    // The preview worker re-checks the request hostname, so a signed URL is inert
    // on the project's default hostname. Without a valid token we can only prove
    // the negative side (a bogus token is refused everywhere), which is exactly
    // what is asserted here.
    const pinned = await get(`${PREVIEW}/p/anything`)
    check('a token on the default pages.dev hostname is not served', pinned.status !== 200, `status=${pinned.status}`)
  }

  // ---------------------------------------------------------------
  // 5. Real browser: no storage/cookies on the preview origin
  // ---------------------------------------------------------------
  section('Real browser: preview origin holds no app state')
  {
    const browser = await chromium.launch({ headless: true })
    try {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await page.goto(`${PREVIEW}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})

      const cookies = await ctx.cookies()
      check('browser holds no cookie for the preview origin', cookies.length === 0, JSON.stringify(cookies).slice(0, 140))

      const storage = await page.evaluate(() => ({
        local: Object.keys(localStorage).length,
        session: Object.keys(sessionStorage).length
      }))
      check('preview origin localStorage is empty', storage.local === 0, `keys=${storage.local}`)
      check('preview origin sessionStorage is empty', storage.session === 0, `keys=${storage.session}`)

      const bodyHtml = await page.content()
      check('rendered preview root contains no shell markup', !hasShell(bodyHtml), `${bodyHtml.length} bytes`)
      await ctx.close()
    } finally {
      await browser.close()
    }
  }

  // ---------------------------------------------------------------
  // 6. Blocked: requires a signed-in owner and an emailed OTP
  // ---------------------------------------------------------------
  section('Authenticated security checklist')
  {
    const why =
      'production OTP is emailed (dev-code mode is off), so this script cannot sign in; ' +
      'run these against the live domains with a session, or with a verified sending domain'
    block('Safe Preview renders HTML/CSS only, JavaScript does not execute', why)
    block('Interactive Preview executes inline JavaScript and forms', why)
    block('no application localStorage/sessionStorage reachable from the artifact', why)
    block('no parent-DOM access from the artifact', why)
    block('no top-navigation escape', why)
    block('no popup escape', why)
    block('fetch / XHR / WebSocket egress blocked', why)
    block('expired / tampered / wrong-secret token refused end to end', why)
    block('share revocation withdraws a live token', why)
    block('owner toggle switches Safe <-> Interactive after a real refetch', why)
    block('raw HTML source is not shown unless explicitly downloaded', why)
  }

  console.log('\n' + '='.repeat(60))
  console.log(`  ${pass} passed, ${fail} failed, ${blocked} blocked (not verified)`)
  if (fail > 0) {
    console.log(`  FAILED: ${failures.join(' | ')}`)
    process.exit(1)
  }
  console.log('  NO FAILURES IN THE VALIDATED SUBSET')
  console.log('  NOTE: blocked items are NOT verified — the checklist is not complete.')
}

main().catch((err) => {
  console.error('\nVALIDATION ERROR:', err?.message ?? err)
  process.exit(1)
})
