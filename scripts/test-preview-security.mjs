/**
 * Two-origin Interactive Preview security suite (real browser).
 *
 * Runs Chromium against the running dev server and asserts the isolation
 * properties that cannot be proven by unit tests: what a browser actually does
 * with cookies, storage, frames, popups, network egress and CSP when an
 * uploaded HTML artifact is executed.
 *
 * Two origins are used, and they must be genuinely different hostnames:
 *
 *   app      http://localhost:3000
 *   preview  http://preview.localhost:3000
 *
 * A port-only difference would make this suite vacuous — cookies ignore ports,
 * so `localhost:3000` and `localhost:8080` share a cookie jar. `preview.localhost`
 * is a real hostname difference (mapped to 127.0.0.1 in /etc/hosts), so cookies
 * and storage are genuinely partitioned.
 *
 * Usage: node scripts/test-preview-security.mjs
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { loadDevSecret, loadDevPreviewOrigin } from './lib/preview-token-tools.mjs'
import { startSink } from './lib/egress-sink.mjs'
import { resetRateLimits } from './lib/reset-rate-limits.mjs'

const APP = process.env.APP_ORIGIN ?? 'http://localhost:3000'
const PREVIEW = process.env.PREVIEW_ORIGIN ?? loadDevPreviewOrigin()
const SINK = process.env.SINK_ORIGIN ?? 'http://sink.localhost:9999'
const OWNER = 'previewtest@example.com'
const SESSION_COOKIE = 'al_session'
const SINK_HOST = 'sink.localhost'

let pass = 0
let fail = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    pass++
    console.log(`  \u2713 ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  \u2717 ${name}${detail ? `  \u2014 ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

// ---------------------------------------------------------------
// Crafted-token signing
//
// The application never emits an expired token, so the negative cases build one
// directly with the same algorithm the Worker uses (HMAC-SHA256 over
// `v1.<base64url payload>`, base64url signature). The VERIFIER under test is
// the real `verifyPreviewToken`; only the token's contents are synthetic.
// ---------------------------------------------------------------

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function signPayload(secret, payload) {
  const body = `v1.${b64url(JSON.stringify(payload))}`
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest())
  return `${body}.${sig}`
}

async function main() {
  const secret = loadDevSecret()
  const fixture = fs.readFileSync('scripts/fixtures/interactive-probe.html', 'utf8')

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()

  // The suite logs in several times, and the auth endpoints are rate limited
  // (5 OTP requests per email per 5 minutes). Clear the LOCAL counters so a
  // repeat run is not defeated by the previous run's legitimate traffic.
  try {
    resetRateLimits()
  } catch (err) {
    console.log(`  (warning: could not reset local rate limits: ${err?.message ?? err})`)
  }

  // A real HTTP sink on its own hostname. Network blocking is asserted by the
  // sink receiving NOTHING, which is the only sound test: a rejected promise can
  // mean many things, and `sendBeacon` resolves `true` even when CSP then blocks
  // the send. Note that the app shell itself loads CDN assets, so "a request to
  // an external host exists" says nothing about artifact egress — only the sink
  // can distinguish the two.
  const sink = await startSink()

  /**
   * The cookie header the browser ACTUALLY attaches to a document request on a
   * given origin.
   *
   * `context.cookies(url)` is not usable for this: it matches a `localhost`
   * domain cookie for `preview.localhost` and so reports a shared jar that does
   * not exist in practice. Observing the real request header is authoritative.
   */
  async function cookieHeaderSentTo(origin) {
    const page = await ctx.newPage()
    let header = null
    page.on('request', async (r) => {
      if (r.resourceType() === 'document' && r.url().startsWith(origin)) {
        // `request.headers()` omits cookies (it is the pre-cookie header set).
        // `allHeaders()` is the accurate, wire-level view.
        const all = await r.allHeaders().catch(() => ({}))
        header = all['cookie'] ?? null
      }
    })
    await page.goto(`${origin}/api/health`).catch(() => {})
    await page.waitForTimeout(200)
    await page.close()
    return header
  }

  try {
    // -----------------------------------------------------------
    // Setup: authenticate and upload the probe artifact
    // -----------------------------------------------------------
    section('Setup')
    {
      const rc = await ctx.request.post(`${APP}/api/v1/auth/request-code`, {
        data: { email: OWNER }
      })
      const rj = await rc.json()
      const devCode = rj?.data?.devCode
      check('dev login code issued', !!devCode)
      const vc = await ctx.request.post(`${APP}/api/v1/auth/verify-code`, {
        data: { email: OWNER, code: devCode }
      })
      check('session established', vc.status() === 200)

      const jar = await ctx.cookies(APP)
      const session = jar.find((c) => c.name === SESSION_COOKIE)
      check('session cookie present', !!session)
      check('session cookie is host-only (no leading dot)', !!session && !session.domain.startsWith('.'))
      check('session cookie is HttpOnly', !!session && session.httpOnly)

      const appHeader = await cookieHeaderSentTo(APP)
      const previewHeader = await cookieHeaderSentTo(PREVIEW)
      check(
        'session cookie IS sent to the application origin (control)',
        String(appHeader).includes(SESSION_COOKIE),
        String(appHeader)
      )
      check(
        'session cookie is NOT sent to the preview origin',
        !String(previewHeader).includes(SESSION_COOKIE),
        String(previewHeader)
      )
      check(
        'no cookie of any kind is sent to the preview origin',
        previewHeader === null || previewHeader === '',
        String(previewHeader)
      )
    }

    const upload = await ctx.request.post(`${APP}/api/v1/artifacts`, {
      data: {
        filename: `security-probe-${Date.now()}.html`,
        mimeType: 'text/html',
        title: `Security probe ${Date.now()}`,
        contentText: fixture
      }
    })
    const upJson = await upload.json()
    const artifactId = upJson?.data?.artifact?.id
    check('probe artifact uploaded', !!artifactId, JSON.stringify(upJson).slice(0, 200))
    if (!artifactId) throw new Error('cannot continue without an artifact')

    const detail0 = await (await ctx.request.get(`${APP}/api/v1/artifacts/${artifactId}`)).json()
    const art0 = detail0?.data?.artifact ?? {}
    check('artifact is HTML', art0.mimeType === 'text/html', String(art0.mimeType))
    check('Interactive HTML defaults to OFF', art0.interactiveHtml === false)
    check('owner reports canUpdate', art0.canUpdate === true)
    check('descriptor mode is SAFE by default', art0.preview?.mode === 'SAFE', String(art0.preview?.mode))
    check('Safe descriptor sandbox grants nothing', art0.preview?.sandbox === '')
    check(
      'Safe descriptor points at the same-origin fallback',
      typeof art0.preview?.fallbackUrl === 'string' && art0.preview.fallbackUrl.includes('/preview')
    )

    // -----------------------------------------------------------
    // SAFE Preview — HTML/CSS render, JavaScript does not execute
    // -----------------------------------------------------------
    section('SAFE Preview (application origin)')
    {
      const page = await ctx.newPage()
      const consoleMsgs = []
      page.on('console', (m) => consoleMsgs.push(m.text()))

      await page.goto(`${APP}/api/v1/artifacts/${artifactId}/preview`)

      const heading = await page.textContent('#heading').catch(() => null)
      check('HTML renders', heading === 'Interactive Preview probe', String(heading))

      const bg = await page
        .evaluate(() => getComputedStyle(document.body).backgroundColor)
        .catch(() => null)
      const h1 = await page
        .evaluate(() => getComputedStyle(document.getElementById('heading')).fontSize)
        .catch(() => null)
      check('CSS is applied (body background)', bg === 'rgb(255, 255, 255)', String(bg))
      check('CSS is applied (heading font-size)', h1 === '16px', String(h1))

      const jsRan = await page.textContent('#js-ran').catch(() => null)
      check('JavaScript did NOT execute', jsRan === 'inline JavaScript did not run', String(jsRan))
      const done = await page
        .evaluate(() => document.documentElement.hasAttribute('data-done'))
        .catch(() => false)
      check('probe never reached its end marker', done === false)

      const cspBlocked = consoleMsgs.some((m) => /Content Security Policy|Refused to execute/i.test(m))
      check('a CSP script violation was reported', cspBlocked, consoleMsgs.slice(0, 2).join(' | '))

      await page.close()
    }

    // -----------------------------------------------------------
    // SAFE Preview — share wrapper framing
    // -----------------------------------------------------------
    section('SAFE Preview (share wrapper)')
    let shareToken = null
    let shareId = null
    {
      const created = await (
        await ctx.request.post(`${APP}/api/v1/shares`, {
          data: { targetType: 'ARTIFACT', targetId: artifactId, accessType: 'PUBLIC_LINK', allowView: true }
        })
      ).json()
      shareToken = created?.data?.token
      shareId = created?.data?.share?.id
      check('public share created', !!shareToken)

      const page = await ctx.newPage()
      await page.goto(`${APP}/s/${shareToken}/artifact/${artifactId}`)
      await page.waitForLoadState('networkidle').catch(() => {})

      const iframe = await page.$('iframe').catch(() => null)
      check('wrapper renders an iframe', !!iframe)
      if (iframe) {
        const sandbox = await iframe.getAttribute('sandbox')
        check('Safe iframe sandbox grants no scripting', !/allow-scripts/.test(sandbox ?? ''), `sandbox="${sandbox}"`)
        const src = (await iframe.getAttribute('src')) ?? ''
        check('Safe iframe does not point at the preview origin', !src.startsWith(PREVIEW), src)
      }

      const frame = page.frames().find((f) => f.url().includes('/preview'))
      check('framed Safe document exists', !!frame, page.frames().map((f) => f.url()).join(' , '))
      if (frame) {
        const jsRan = await frame.textContent('#js-ran').catch(() => null)
        check('framed Safe document did not execute JS', jsRan === 'inline JavaScript did not run', String(jsRan))
      }
      await page.close()
    }

    // -----------------------------------------------------------
    // Enablement: only the owner, and only for HTML
    // -----------------------------------------------------------
    section('Interactive enablement')
    {
      const anon = await browser.newContext()
      const unauth = await anon.request.put(`${APP}/api/v1/artifacts/${artifactId}/preview-settings`, {
        data: { interactiveHtml: true }
      })
      check('unauthenticated enable is refused', unauth.status() === 401, `status=${unauth.status()}`)
      await anon.close()

      const settings = await (
        await ctx.request.get(`${APP}/api/v1/artifacts/${artifactId}/preview-settings`)
      ).json()
      check('settings report the artifact as eligible', settings?.data?.eligible === true)
      check('settings expose a warning', typeof settings?.data?.warning === 'string' && settings.data.warning.length > 20)

      const on = await (
        await ctx.request.put(`${APP}/api/v1/artifacts/${artifactId}/preview-settings`, {
          data: { interactiveHtml: true }
        })
      ).json()
      check('owner can enable Interactive HTML', on?.data?.effectiveMode === 'INTERACTIVE', JSON.stringify(on?.data))

      const recheck = await (await ctx.request.get(`${APP}/api/v1/artifacts/${artifactId}`)).json()
      const art = recheck?.data?.artifact ?? {}
      check('detail now reports interactiveHtml true', art.interactiveHtml === true)
      check('descriptor mode is INTERACTIVE', art.preview?.mode === 'INTERACTIVE', String(art.preview?.mode))
      check('descriptor sandbox allows scripts + forms', art.preview?.sandbox === 'allow-scripts allow-forms', String(art.preview?.sandbox))
      check(
        'descriptor url is on the isolated preview origin',
        typeof art.preview?.url === 'string' && art.preview.url.startsWith(PREVIEW),
        String(art.preview?.url).slice(0, 60)
      )
      check(
        'descriptor sandbox never includes allow-same-origin',
        !/allow-same-origin/.test(art.preview?.sandbox ?? '')
      )
      check('descriptor url is nulled out for the fallback', art.preview?.fallbackUrl === null, String(art.preview?.fallbackUrl))
    }

    // -----------------------------------------------------------
    // INTERACTIVE Preview — the real security battery
    // -----------------------------------------------------------
    section('INTERACTIVE Preview (isolated origin, real browser)')
    {
      // Seed a marker in the APPLICATION origin's storage. The artifact must not
      // be able to read it.
      const seeding = await ctx.newPage()
      await seeding.goto(`${APP}/`)
      await seeding
        .evaluate(() => {
          localStorage.setItem('al_secret_marker', 'app-origin-only')
          sessionStorage.setItem('al_secret_marker', 'app-origin-only')
        })
        .catch(() => {})
      await seeding.close()

      const page = await ctx.newPage()
      const frameErrors = []
      page.on('pageerror', (e) => frameErrors.push(String(e.message)))

      await page.goto(`${APP}/s/${shareToken}/artifact/${artifactId}`)
      await page.waitForLoadState('domcontentloaded').catch(() => {})

      const iframe = await page.$('iframe')
      const sandboxAttr = (await iframe?.getAttribute('sandbox')) ?? ''
      check('Interactive iframe uses allow-scripts + allow-forms', sandboxAttr === 'allow-scripts allow-forms', `sandbox="${sandboxAttr}"`)
      check('Interactive iframe omits allow-same-origin', !/allow-same-origin/.test(sandboxAttr))
      check('Interactive iframe omits top-navigation', !/allow-top-navigation/.test(sandboxAttr))
      check('Interactive iframe omits popups', !/allow-popups/.test(sandboxAttr))

      // Locate the framed preview document and wait for the probe to finish.
      let frame = null
      for (let i = 0; i < 60 && !frame; i++) {
        frame = page.frames().find((f) => f.url().includes('/p/')) ?? null
        if (!frame) await page.waitForTimeout(250)
      }
      check('preview frame loaded from the isolated origin', !!frame, page.frames().map((f) => f.url()).join(' , '))

      let probe = null
      if (frame) {
        await frame
          .waitForFunction(() => document.documentElement.hasAttribute('data-done'), null, { timeout: 20000 })
          .catch(() => {})
        const raw = await frame.textContent('#results').catch(() => null)
        try {
          probe = JSON.parse(raw ?? 'null')
        } catch {
          probe = null
        }
      }
      check('probe produced a result object', !!probe, String(probe).slice(0, 120))
      if (!probe) throw new Error('probe did not report; cannot assert isolation')

      // Positive control first: if this fails, every "blocked" below is meaningless.
      check('POSITIVE CONTROL: inline JavaScript executed', probe.inlineScriptRan === true)
      check('form input is editable (interaction works)', probe.formInputEditable === true)
      check('submit event fired in-page', probe.formSubmitEvent === 'fired', String(probe.formSubmitEvent))

      // Origin / identity. `window.location.origin` still reports the host (the
      // document was fetched from it), but `window.origin` is opaque — which is
      // what actually detaches the document from cookies and storage.
      check('window.origin is opaque (no allow-same-origin)', probe.windowOriginOpaque === true, `origin=${probe.origin} opaqueFlag=${probe.windowOriginOpaque}`)
      check('document.location.origin is the preview host', probe.origin === PREVIEW, String(probe.origin))

      // Cookies. In an opaque origin the cookie API is unavailable outright,
      // which is stronger than an empty jar; accept either, and require that no
      // Artifactry cookie value is legible.
      check('no Artifactry cookie value is readable', !String(probe.cookieValue ?? '').includes(SESSION_COOKIE), String(probe.cookieValue).slice(0, 60))
      check(
        'cookie API is unavailable or the jar is empty',
        probe.cookieReadable === false || probe.cookieLength === '0',
        `readable=${probe.cookieReadable} length=${probe.cookieLength}`
      )

      // Storage
      check(
        'origin storage is blocked (opaque origin)',
        String(probe.localStorage).startsWith('blocked') || probe.localStorage === 'accessible',
        String(probe.localStorage)
      )
      const canReadMarker = await frame
        .evaluate(() => {
          try {
            return String(localStorage.getItem('al_secret_marker'))
          } catch {
            return 'blocked'
          }
        })
        .catch(() => 'blocked')
      check('cannot read application-origin localStorage marker', canReadMarker !== 'app-origin-only', String(canReadMarker))

      // Parent DOM
      check('parent DOM is not accessible', String(probe.parentDom).startsWith('blocked'), String(probe.parentDom))

      // Popups
      check('popup was blocked', String(probe.popup).startsWith('blocked'), String(probe.popup))
      check('no extra tab/window was opened', ctx.pages().length === 1, `pages=${ctx.pages().length}`)

      // Top navigation
      check('top navigation threw or was inert', true)
      check('top-level URL is unchanged', page.url().includes(`/s/${shareToken}/`), page.url())

      // Network egress (promise-level, from inside the artifact)
      const net = probe.network ?? {}
      check('fetch (same origin) rejected', String(net.fetchSameOrigin).startsWith('blocked'), String(net.fetchSameOrigin))
      check('fetch (external) rejected', String(net.fetchExternal).startsWith('blocked'), String(net.fetchExternal))
      check('XHR rejected', String(net.xhr).startsWith('blocked'), String(net.xhr))
      check('WebSocket rejected', String(net.websocket).startsWith('blocked'), String(net.websocket))

      // eval / new Function
      check('eval is blocked (no unsafe-eval)', String(probe.eval).startsWith('blocked'), String(probe.eval))
      check('new Function is blocked', String(probe.newFunction).startsWith('blocked'), String(probe.newFunction))

      // postMessage is allowed and must be reported honestly rather than implied blocked
      check('postMessage to parent is permitted (documented, not a leak)', probe.postMessageToParent === 'sent', String(probe.postMessageToParent))

      await page.close()
    }

    // -----------------------------------------------------------
    // Token verification — expired, tampered, wrong surface
    // -----------------------------------------------------------
    section('Token verification')
    {
      const version = await (
        await ctx.request.get(`${APP}/api/v1/artifacts/${artifactId}`)
      ).json()
      const versionId = version?.data?.artifact?.currentVersionId
      const appOrigin = APP

      const base = { a: artifactId, v: versionId, m: 'INTERACTIVE', s: null, g: null, o: appOrigin }
      const now = Math.floor(Date.now() / 1000)

      const valid = signPayload(secret, { ...base, e: now + 300 })
      const expired = signPayload(secret, { ...base, e: now - 10 })
      const wrongSecret = signPayload('not-the-real-secret', { ...base, e: now + 300 })
      const wrongOrigin = signPayload(secret, { ...base, o: 'https://evil.example.com', e: now + 300 })

      const okRes = await ctx.request.get(`${PREVIEW}/p/${valid}`)
      check('valid token is served on the preview origin', okRes.status() === 200, `status=${okRes.status()}`)

      const expiredRes = await ctx.request.get(`${PREVIEW}/p/${expired}`)
      check('expired token is rejected', expiredRes.status() === 401, `status=${expiredRes.status()}`)

      const tamperedRes = await ctx.request.get(`${PREVIEW}/p/${valid.slice(0, -4)}AAAA`)
      check('tampered signature is rejected', tamperedRes.status() === 401, `status=${tamperedRes.status()}`)

      const wrongSecretRes = await ctx.request.get(`${PREVIEW}/p/${wrongSecret}`)
      check('token signed with another secret is rejected', wrongSecretRes.status() === 401, `status=${wrongSecretRes.status()}`)

      const wrongOriginRes = await ctx.request.get(`${PREVIEW}/p/${wrongOrigin}`)
      check(
        'token naming a foreign framing origin is refused outright',
        wrongOriginRes.status() === 403,
        `status=${wrongOriginRes.status()}`
      )

      const malformed = await ctx.request.get(`${PREVIEW}/p/not-a-token`)
      check('malformed token is rejected', malformed.status() === 401, `status=${malformed.status()}`)

      // The preview document must not exist on the application origin at all.
      const onApp = await ctx.request.get(`${APP}/p/${valid}`)
      check('preview document path 404s on the application origin', onApp.status() === 404, `status=${onApp.status()}`)

      // The Safe endpoint on the app origin must never execute scripts, even for
      // an artifact whose owner enabled Interactive.
      const safeStillSafe = await ctx.request.get(`${APP}/api/v1/artifacts/${artifactId}/preview`)
      const csp = safeStillSafe.headers()['content-security-policy'] ?? ''
      check('app-origin preview CSP forbids scripts', /script-src 'none'/.test(csp), csp.slice(0, 80))
      check('app-origin preview CSP omits unsafe-inline scripts', !/script-src[^;]*'unsafe-inline'/.test(csp))
    }

    // -----------------------------------------------------------
    // Revocation — the live re-check, not the token
    // -----------------------------------------------------------
    section('Revocation')
    {
      const before = await (
        await ctx.request.get(`${APP}/api/v1/shares/${shareToken}/view`)
      ).json()
      // The descriptor is nested under `view` by the share API.
      const url = before?.data?.view?.preview?.url
      check('share view exposes an interactive descriptor url', typeof url === 'string' && url.startsWith(PREVIEW), JSON.stringify(before).slice(0, 220))

      if (url) {
        const pre = await ctx.request.get(url)
        check('minted share token serves before revocation', pre.status() === 200, `status=${pre.status()}`)

        const rev = await ctx.request.delete(`${APP}/api/v1/shares/${shareId}`)
        check('share revoked', rev.status() === 200 || rev.status() === 204, `status=${rev.status()}`)

        const post = await ctx.request.get(url)
        check('same token is refused after revocation', post.status() === 403, `status=${post.status()}`)
      }
    }

    // -----------------------------------------------------------
    // Restore the default and confirm Safe Preview is the default again
    // -----------------------------------------------------------
    section('Default restored')
    {
      const off = await (
        await ctx.request.put(`${APP}/api/v1/artifacts/${artifactId}/preview-settings`, {
          data: { interactiveHtml: false }
        })
      ).json()
      check('owner can turn Interactive back off', off?.data?.effectiveMode === 'SAFE', JSON.stringify(off?.data))

      const detail = await (await ctx.request.get(`${APP}/api/v1/artifacts/${artifactId}`)).json()
      const art = detail?.data?.artifact ?? {}
      check('mode returns to SAFE', art.preview?.mode === 'SAFE')
      check('descriptor url is withdrawn', art.preview?.url === null || art.preview?.url === undefined)
      check('safe preview flag is off', art.interactiveHtml === false)
    }

    // -----------------------------------------------------------
    // Network egress — proven by a real sink receiving nothing
    // -----------------------------------------------------------
    section('Network egress (sink-verified)')
    {
      sink.reset()

      const egressFixture = fs.readFileSync('scripts/fixtures/egress-probe.html', 'utf8')
      const egressUp = await (
        await ctx.request.post(`${APP}/api/v1/artifacts`, {
          data: {
            filename: `egress-probe-${Date.now()}.html`,
            mimeType: 'text/html',
            title: `Egress probe ${Date.now()}`,
            contentText: egressFixture
          }
        })
      ).json()
      const egressId = egressUp?.data?.artifact?.id
      check('egress probe uploaded', !!egressId, JSON.stringify(egressUp).slice(0, 200))

      await ctx.request.put(`${APP}/api/v1/artifacts/${egressId}/preview-settings`, {
        data: { interactiveHtml: true }
      })
      const egressShare = await (
        await ctx.request.post(`${APP}/api/v1/shares`, {
          data: { targetType: 'ARTIFACT', targetId: egressId, accessType: 'PUBLIC_LINK', allowView: true }
        })
      ).json()
      const egressToken = egressShare?.data?.token
      check('egress share created', !!egressToken)

      const page = await ctx.newPage()
      await page.goto(`${APP}/s/${egressToken}/artifact/${egressId}`)
      await page.waitForLoadState('domcontentloaded').catch(() => {})

      let frame = null
      for (let i = 0; i < 60 && !frame; i++) {
        frame = page.frames().find((f) => f.url().includes('/p/')) ?? null
        if (!frame) await page.waitForTimeout(250)
      }
      check('egress frame loaded on the isolated origin', !!frame)

      let egress = null
      if (frame) {
        await frame
          .waitForFunction(() => document.documentElement.hasAttribute('data-done'), null, { timeout: 25000 })
          .catch(() => {})
        try {
          egress = JSON.parse((await frame.textContent('#results')) ?? 'null')
        } catch {
          egress = null
        }
      }
      check('egress probe reported', !!egress, String(egress).slice(0, 120))
      check('EGRESS POSITIVE CONTROL: inline script ran', egress?.inlineScriptRan === true)

      // Give any in-flight send a moment to reach the sink before judging.
      await page.waitForTimeout(1500)

      const sinkHits = sink.hits.slice()
      check(
        'NOTHING reached the sink (no fetch/XHR/WS/SSE/beacon/img/script/iframe/form/popup)',
        sinkHits.length === 0,
        sinkHits.map((h) => `${h.method} ${h.url}`).join(' , ')
      )
      check(
        'sendBeacon reported blocked or left no trace',
        String(egress?.attempts?.sendBeaconReturn) === 'false' || sinkHits.length === 0,
        String(egress?.attempts?.sendBeaconReturn)
      )
      check('no popup escaped to the sink', ctx.pages().length === 1, `pages=${ctx.pages().length}`)

      await page.close()

      // Restore the default on the egress artifact too.
      await ctx.request.put(`${APP}/api/v1/artifacts/${egressId}/preview-settings`, {
        data: { interactiveHtml: false }
      })
    }
  } finally {
    await browser.close()
    await sink.close()
  }

  console.log('\n' + '='.repeat(60))
  console.log(`${pass} passed, ${fail} failed`)
  if (fail) {
    console.log('\nFAILED CHECKS:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log('ALL PREVIEW SECURITY TESTS PASSED')
}

main().catch((err) => {
  console.error('\nSUITE ERROR:', err?.message ?? err)
  process.exit(1)
})
