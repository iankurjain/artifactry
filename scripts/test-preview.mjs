/**
 * Preview-origin test suite.
 *
 * Covers the security properties the isolated preview origin depends on:
 * signed-token integrity, short expiry, origin classification, fail-closed mode
 * resolution, and the exact CSP/sandbox shape of each mode.
 *
 * Runs the real shipped module (bundled with esbuild, platform: neutral) rather
 * than a reimplementation, so a change to the policy builders or the verifier is
 * caught here.
 *
 * Run: node scripts/test-preview.mjs
 */

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let failures = 0
let passes = 0

function check(name, condition, detail = '') {
  if (condition) {
    passes++
    console.log(`  [PASS] ${name}`)
  } else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

mkdirSync('/tmp/build', { recursive: true })
await build({
  entryPoints: ['src/lib/htmlpreview.ts'],
  outfile: '/tmp/build/htmlpreview.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'error'
})

const hp = await import(pathToFileURL('/tmp/build/htmlpreview.mjs').href)
const {
  PREVIEW_TOKEN_TTL_SECONDS,
  PREVIEW_TOKEN_MAX_TTL_SECONDS,
  clampPreviewTtl,
  previewOrigin,
  previewOriginHost,
  interactiveAvailable,
  normalizeOrigin,
  classifyRequest,
  resolvePreviewMode,
  mintPreviewToken,
  verifyPreviewToken,
  previewDocumentUrl,
  safePreviewCsp,
  interactivePreviewCsp,
  previewCspFor,
  previewDocumentCsp,
  previewSandbox
} = hp

const APP_ORIGIN = 'https://artifact-library.pages.dev'
const PREVIEW = 'https://preview.artifactry.app'

const withSecret = { PREVIEW_TOKEN_SECRET: 'test-secret-value' }
const both = { PREVIEW_ORIGIN: PREVIEW, PREVIEW_TOKEN_SECRET: 'test-secret-value' }
const onlyOrigin = { PREVIEW_ORIGIN: PREVIEW }
const neither = {}

// ---------------------------------------------------------------
section('Origin normalisation and availability')
// ---------------------------------------------------------------

check('a configured origin normalises to its origin', previewOrigin(both) === PREVIEW)
check('a bare hostname with a path yields just the origin',
  previewOrigin({ PREVIEW_ORIGIN: 'https://preview.artifactry.app/some/path?x=1' }) === PREVIEW)
check('the preview host is exposed', previewOriginHost(both) === 'preview.artifactry.app')
check('a non-http scheme is rejected', previewOrigin({ PREVIEW_ORIGIN: 'ftp://x.example' }) === null)
check('garbage is rejected', previewOrigin({ PREVIEW_ORIGIN: 'not a url' }) === null)
check('an empty origin is rejected', previewOrigin({ PREVIEW_ORIGIN: '   ' }) === null)
check('no origin configured yields null', previewOrigin(neither) === null)
check('normalizeOrigin keeps the port',
  normalizeOrigin('http://localhost:3000/x') === 'http://localhost:3000')
check('normalizeOrigin rejects a relative path', normalizeOrigin('/p/token') === null)

check('availability requires BOTH origin and secret', interactiveAvailable(both) === true)
check('availability is false with only an origin', interactiveAvailable(onlyOrigin) === false)
check('availability is false with only a secret',
  interactiveAvailable({ PREVIEW_TOKEN_SECRET: 'x' }) === false)
check('availability is false when unconfigured', interactiveAvailable(neither) === false)

// ---------------------------------------------------------------
section('Origin classification (surface gate)')
// ---------------------------------------------------------------

check('with no preview origin, every request is the APP surface',
  classifyRequest(neither, `${APP_ORIGIN}/library`) === 'APP')
check('with no preview origin, even the preview path is APP',
  classifyRequest(neither, `${PREVIEW}/p/abc`) === 'APP')
check('the configured origin is the PREVIEW surface',
  classifyRequest(both, `${PREVIEW}/p/abc`) === 'PREVIEW')
check('the app origin is the APP surface',
  classifyRequest(both, `${APP_ORIGIN}/library`) === 'APP')
check('a look-alike subdomain is NOT the preview surface',
  classifyRequest(both, 'https://evil.preview.artifactry.app/p/abc') === 'APP')
check('a look-alike superdomain is NOT the preview surface',
  classifyRequest(both, 'https://artifactry.app/p/abc') === 'APP')
check('a scheme mismatch is NOT the preview surface',
  classifyRequest(both, 'http://preview.artifactry.app/p/abc') === 'APP')
check('classification agrees with the browser about ports',
  classifyRequest({ PREVIEW_ORIGIN: 'http://localhost:8080' }, 'http://localhost:3000/p/x') === 'APP')
check('a matching port classifies as PREVIEW',
  classifyRequest({ PREVIEW_ORIGIN: 'http://localhost:8080' }, 'http://localhost:8080/p/x') === 'PREVIEW')
check('the Host header is honoured when the URL is unparseable',
  classifyRequest({ PREVIEW_ORIGIN: 'https://preview.artifactry.app' }, 'nonsense', 'preview.artifactry.app') === 'PREVIEW')

// ---------------------------------------------------------------
section('Mode resolution is fail-closed')
// ---------------------------------------------------------------

const off = resolvePreviewMode({ interactive_html: 0 }, both)
check('flag 0 resolves to SAFE', off.mode === 'SAFE')
check('flag 0 is not a downgrade', off.requested === false)

check('a missing column defaults to SAFE', resolvePreviewMode({}, both).mode === 'SAFE')
check('null defaults to SAFE', resolvePreviewMode({ interactive_html: null }, both).mode === 'SAFE')

const noOrigin = resolvePreviewMode({ interactive_html: 1 }, onlyOrigin)
check('flag 1 with an origin but NO secret stays SAFE', noOrigin.mode === 'SAFE')
check('the downgrade is reported', noOrigin.requested === true)
check('the downgrade carries a reason', /secret is missing/.test(noOrigin.reason), noOrigin.reason)

const noSecret = resolvePreviewMode({ interactive_html: 1 }, { PREVIEW_TOKEN_SECRET: 'x' })
check('flag 1 with a secret but NO origin stays SAFE', noSecret.mode === 'SAFE')
check('that downgrade carries a reason', /no isolated preview origin/.test(noSecret.reason), noSecret.reason)

check('flag 1 with NOTHING configured stays SAFE', resolvePreviewMode({ interactive_html: 1 }, neither).mode === 'SAFE')

const interactive = resolvePreviewMode({ interactive_html: 1 }, both)
check('flag 1 with both configured resolves to INTERACTIVE', interactive.mode === 'INTERACTIVE')
check('the interactive reason names the origin', interactive.reason.includes('preview.artifactry.app'))

check('a boolean true is honoured', resolvePreviewMode({ interactive_html: true }, both).mode === 'INTERACTIVE')
check('a truthy non-1 number is NOT honoured (strict === 1)',
  resolvePreviewMode({ interactive_html: 2 }, both).mode === 'SAFE')

// ---------------------------------------------------------------
section('Signed preview tokens')
// ---------------------------------------------------------------

const token = await mintPreviewToken(withSecret, {
  artifactId: 'art_1',
  versionId: 'ver_1',
  mode: 'INTERACTIVE',
  shareId: 'shr_1',
  grantId: 'grt_1',
  appOrigin: APP_ORIGIN
})
check('a token is minted', typeof token === 'string' && token.split('.').length === 3)

const decoded = await verifyPreviewToken(withSecret, token)
check('a valid token verifies', decoded !== null)
check('the artifact id round-trips', decoded?.a === 'art_1')
check('the version id round-trips', decoded?.v === 'ver_1')
check('the mode round-trips', decoded?.m === 'INTERACTIVE')
check('the share id round-trips', decoded?.s === 'shr_1')
check('the grant id round-trips', decoded?.g === 'grt_1')
check('the framing origin round-trips as an origin', decoded?.o === APP_ORIGIN)

const noGrant = await verifyPreviewToken(
  withSecret,
  await mintPreviewToken(withSecret, {
    artifactId: 'a',
    versionId: 'v',
    mode: 'SAFE',
    appOrigin: APP_ORIGIN
  })
)
check('an omitted share/grant reads back as null',
  noGrant?.s === null && noGrant?.g === null)

check('minting without a secret returns null',
  (await mintPreviewToken({}, { artifactId: 'a', versionId: 'v', mode: 'SAFE', appOrigin: APP_ORIGIN })) === null)
check('minting with a non-http app origin returns null',
  (await mintPreviewToken(withSecret, {
    artifactId: 'a', versionId: 'v', mode: 'SAFE', appOrigin: 'javascript:alert(1)'
  })) === null)
check('minting with an empty artifact id returns null',
  (await mintPreviewToken(withSecret, {
    artifactId: '', versionId: 'v', mode: 'SAFE', appOrigin: APP_ORIGIN
  })) === null)
check('the framing origin is reduced to an origin, never a path',
  (await verifyPreviewToken(withSecret, await mintPreviewToken(withSecret, {
    artifactId: 'a', versionId: 'v', mode: 'SAFE', appOrigin: `${APP_ORIGIN}/evil/path`
  })))?.o === APP_ORIGIN)

// --- tampering ---------------------------------------------------

const [v1, body, sig] = token.split('.')
check('a tampered payload fails (signature mismatch)',
  (await verifyPreviewToken(withSecret, `${v1}.${body}x.${sig}`)) === null)
check('a tampered signature fails',
  (await verifyPreviewToken(withSecret, `${v1}.${body}.${sig}x`)) === null)
check('a wrong version prefix fails',
  (await verifyPreviewToken(withSecret, `v2.${body}.${sig}`)) === null)
check('a token signed with a different secret fails',
  (await verifyPreviewToken({ PREVIEW_TOKEN_SECRET: 'other' }, token)) === null)
check('a token with no secret configured fails',
  (await verifyPreviewToken({}, token)) === null)
check('a malformed token (two parts) fails',
  (await verifyPreviewToken(withSecret, `${v1}.${body}`)) === null)
check('an empty token fails', (await verifyPreviewToken(withSecret, '')) === null)
check('a non-base64 payload fails',
  (await verifyPreviewToken(withSecret, `${v1}.$$$$.{sig}`)) === null)

// A payload that is valid JSON but has an unknown mode must not verify, even
// when correctly signed — so this is signed with the real secret below.
const { createHmac } = await import('node:crypto')
function signRaw(secret, version, obj) {
  const body = `${version}.${Buffer.from(JSON.stringify(obj)).toString('base64url')}`
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

const SECRET = 'test-secret-value'
const now = Math.floor(Date.now() / 1000)

check('a correctly signed token with an unknown mode fails',
  (await verifyPreviewToken(withSecret, signRaw(SECRET, 'v1', {
    a: 'a', v: 'v', m: 'EXECUTE', s: null, g: null, o: APP_ORIGIN, e: now + 600
  }))) === null)
check('a correctly signed token with a missing framing origin fails',
  (await verifyPreviewToken(withSecret, signRaw(SECRET, 'v1', {
    a: 'a', v: 'v', m: 'SAFE', s: null, g: null, e: now + 600
  }))) === null)
check('a correctly signed token with a non-http framing origin fails',
  (await verifyPreviewToken(withSecret, signRaw(SECRET, 'v1', {
    a: 'a', v: 'v', m: 'SAFE', s: null, g: null, o: 'javascript:alert(1)', e: now + 600
  }))) === null)
check('a correctly signed token with an empty artifact id fails',
  (await verifyPreviewToken(withSecret, signRaw(SECRET, 'v1', {
    a: '', v: 'v', m: 'SAFE', s: null, g: null, o: APP_ORIGIN, e: now + 600
  }))) === null)
check('a correctly signed token with an empty version id fails',
  (await verifyPreviewToken(withSecret, signRaw(SECRET, 'v1', {
    a: 'a', v: '', m: 'SAFE', s: null, g: null, o: APP_ORIGIN, e: now + 600
  }))) === null)
check('a correctly signed token with a non-string grant id fails',
  (await verifyPreviewToken(withSecret, signRaw(SECRET, 'v1', {
    a: 'a', v: 'v', m: 'SAFE', s: null, g: 42, o: APP_ORIGIN, e: now + 600
  }))) === null)

// --- expiry ------------------------------------------------------

check('an expired token fails',
  (await verifyPreviewToken(withSecret, signRaw(SECRET, 'v1', {
    a: 'a', v: 'v', m: 'SAFE', s: null, g: null, o: APP_ORIGIN, e: now - 1
  }))) === null)
check('a token expiring exactly now fails (<= now)',
  (await verifyPreviewToken(withSecret, signRaw(SECRET, 'v1', {
    a: 'a', v: 'v', m: 'SAFE', s: null, g: null, o: APP_ORIGIN, e: now
  }))) === null)
check('a token with a non-numeric expiry fails',
  (await verifyPreviewToken(withSecret, signRaw(SECRET, 'v1', {
    a: 'a', v: 'v', m: 'SAFE', s: null, g: null, o: APP_ORIGIN, e: 'soon'
  }))) === null)

// --- TTL ---------------------------------------------------------

check('the default TTL is short (<= 15 minutes)', PREVIEW_TOKEN_TTL_SECONDS <= 900)
check('a requested TTL is clamped to the ceiling',
  clampPreviewTtl(999999) === PREVIEW_TOKEN_MAX_TTL_SECONDS)
check('a zero/negative TTL falls back to the default',
  clampPreviewTtl(0) === PREVIEW_TOKEN_TTL_SECONDS && clampPreviewTtl(-5) === PREVIEW_TOKEN_TTL_SECONDS)
check('an undefined TTL falls back to the default',
  clampPreviewTtl(undefined) === PREVIEW_TOKEN_TTL_SECONDS)

const shortToken = await verifyPreviewToken(withSecret, await mintPreviewToken(withSecret, {
  artifactId: 'a', versionId: 'v', mode: 'SAFE', appOrigin: APP_ORIGIN, ttlSeconds: 999999
}))
check('a clamped token still expires within the ceiling',
  (shortToken?.e ?? 0) - now <= PREVIEW_TOKEN_MAX_TTL_SECONDS + 2)

// ---------------------------------------------------------------
section('Preview document URL')
// ---------------------------------------------------------------

check('a document URL is built on the isolated origin',
  previewDocumentUrl(both, 'tok') === `${PREVIEW}/p/tok`)
check('no document URL without an origin', previewDocumentUrl(neither, 'tok') === null)

// ---------------------------------------------------------------
section('CSP and sandbox per mode')
// ---------------------------------------------------------------

const safe = safePreviewCsp(APP_ORIGIN)
check('Safe Preview forbids all script', safe.includes("script-src 'none'"))
check('Safe Preview allows inline style so CSS renders', safe.includes("style-src 'unsafe-inline'"))
check('Safe Preview blocks network egress', safe.includes("connect-src 'none'"))
check('Safe Preview blocks framing others', safe.includes("frame-src 'none'"))
check('Safe Preview blocks form submission', safe.includes("form-action 'none'"))
check('Safe Preview blocks <base> hijack', safe.includes("base-uri 'none'"))
check('Safe Preview names the framing origin', safe.includes(`frame-ancestors ${APP_ORIGIN}`))
check('Safe Preview never contains a nonce', !/nonce-/.test(safe))
check('Safe Preview never permits unsafe-inline script',
  !/script-src[^;]*unsafe-inline/.test(safe))

const inter = interactivePreviewCsp(APP_ORIGIN)
check('Interactive Preview permits inline script', /script-src[^;]*unsafe-inline/.test(inter))
check('Interactive Preview still blocks egress by default', inter.includes("connect-src 'none'"))
check('Interactive Preview still blocks form submission', inter.includes("form-action 'none'"))
check('Interactive Preview does NOT enable unsafe-eval', !inter.includes("'unsafe-eval'"))
check('Interactive Preview names the framing origin', inter.includes(`frame-ancestors ${APP_ORIGIN}`))
check('Interactive Preview allows no external script origin',
  !/script-src[^;]*https?:\/\//.test(inter))

check('previewCspFor picks Safe for SAFE', previewCspFor('SAFE', APP_ORIGIN) === safe)
check('previewCspFor picks Interactive for INTERACTIVE',
  previewCspFor('INTERACTIVE', APP_ORIGIN) === inter)

// --- document-level sandbox (travels with the bytes) -------------

const docSafe = previewDocumentCsp('SAFE', APP_ORIGIN)
const docInter = previewDocumentCsp('INTERACTIVE', APP_ORIGIN)
check('the Safe document CSP carries a sandbox directive', /(^|; )sandbox(;|$)/.test(docSafe))
check('the Safe document sandbox grants nothing', /sandbox(;|$)/.test(docSafe) && !/sandbox[^;]*allow/.test(docSafe))
check('the Interactive document sandbox grants scripts and forms',
  /sandbox[^;]*allow-scripts/.test(docInter) && /sandbox[^;]*allow-forms/.test(docInter))
check('the Interactive document sandbox grants NOTHING else',
  (docInter.match(/allow-[a-z-]+/g) ?? []).sort().join(',') === 'allow-forms,allow-scripts',
  (docInter.match(/allow-[a-z-]+/g) ?? []).join(','))

// --- the isolation invariant -------------------------------------

check('Safe Preview sandbox grants nothing', previewSandbox('SAFE') === '')
check('Interactive Preview sandbox is allow-scripts allow-forms',
  previewSandbox('INTERACTIVE') === 'allow-scripts allow-forms')
check('no sandbox token ever includes allow-same-origin',
  !previewSandbox('SAFE').includes('allow-same-origin') &&
  !previewSandbox('INTERACTIVE').includes('allow-same-origin'))
check('no document CSP ever includes allow-same-origin',
  !docSafe.includes('allow-same-origin') && !docInter.includes('allow-same-origin'))
check('neither mode permits top navigation',
  !previewSandbox('INTERACTIVE').includes('top-navigation') &&
  !previewSandbox('SAFE').includes('top-navigation'))
check('neither mode permits popups',
  !previewSandbox('INTERACTIVE').includes('popups') &&
  !previewSandbox('SAFE').includes('popups'))

console.log('\n' + '='.repeat(52))
console.log(`${passes} passed, ${failures} failed`)
console.log(failures === 0 ? 'ALL PREVIEW TESTS PASSED' : 'PREVIEW TESTS FAILED')
process.exit(failures === 0 ? 0 : 1)
