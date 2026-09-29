/**
 * Interactive HTML toggle — real-DOM UI verification.
 *
 * Step 2 asks for an owner-only `Interactive HTML: OFF / ON` control that is
 * default-OFF, shows a warning before enabling, is hidden for non-HTML
 * artifacts, and drives the iframe from the backend descriptor rather than any
 * hardcoded URL or sandbox value.
 *
 * Reading that code proves nothing about whether the rendered UI behaves that
 * way, so this drives a real browser against the running dev server and asserts
 * on the actual DOM.
 *
 * Usage: node scripts/test-preview-ui.mjs
 */

import fs from 'node:fs'
import { chromium } from 'playwright'
import { resetRateLimits } from './lib/reset-rate-limits.mjs'
import { loadDevPreviewOrigin } from './lib/preview-token-tools.mjs'

const APP = process.env.APP_ORIGIN ?? 'http://localhost:3000'
// Read from .dev.vars rather than hardcoding, so the suite follows the
// configured preview origin (the dedicated worker runs on its own port).
const PREVIEW = process.env.PREVIEW_ORIGIN ?? loadDevPreviewOrigin()
const OWNER = process.env.UI_OWNER ?? 'previewtest@example.com'
const VIEWER = process.env.UI_VIEWER ?? 'previewviewer@example.com'

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

/** Log in and return the context. */
async function loginAs(browser, email) {
  const ctx = await browser.newContext()
  const rc = await ctx.request.post(`${APP}/api/v1/auth/request-code`, { data: { email } })
  const rj = await rc.json()
  await ctx.request.post(`${APP}/api/v1/auth/verify-code`, {
    data: { email, code: rj?.data?.devCode }
  })
  return ctx
}

async function upload(ctx, { filename, mimeType, content, title }) {
  const res = await ctx.request.post(`${APP}/api/v1/artifacts`, {
    data: { filename, mimeType, title, contentText: content }
  })
  return (await res.json())?.data?.artifact?.id
}

/** Open the artifact detail screen in the SPA and wait for the card to mount. */
async function openDetail(ctx, artifactId, { waitForCard = true } = {}) {
  const page = await ctx.newPage()
  await page.goto(`${APP}/a/${artifactId}`)
  await page.waitForSelector('#app [data-screen], #app .card, #app h1', { timeout: 15000 }).catch(() => {})
  if (waitForCard) {
    await page
      .waitForSelector('#html-preview-body .skeleton, #html-preview-toggle, #html-preview-card', {
        timeout: 8000
      })
      .catch(() => {})
    // Let the settings fetch settle.
    await page.waitForTimeout(600)
  }
  return page
}

async function main() {
  try {
    resetRateLimits()
  } catch {
    /* best effort */
  }

  const browser = await chromium.launch({ headless: true })

  try {
    const ownerCtx = await loginAs(browser, OWNER)

    const htmlId = await upload(ownerCtx, {
      filename: `ui-html-${Date.now()}.html`,
      mimeType: 'text/html',
      title: `UI HTML ${Date.now()}`,
      content: '<!DOCTYPE html><html><head><title>t</title></head><body><h1 id="h">hi</h1><script>document.title="ran"</script></body></html>'
    })
    check('HTML artifact uploaded', !!htmlId)

    const pdfId = await upload(ownerCtx, {
      filename: `ui-image-${Date.now()}.png`,
      mimeType: 'image/png',
      title: `UI non-html ${Date.now()}`,
      content: 'not actually a png, but the point is a non-HTML mime type'
    })
    check('non-HTML artifact uploaded', !!pdfId)

    // ---------------------------------------------------------
    section('Owner · HTML artifact: card + default OFF')
    // ---------------------------------------------------------
    const htmlPage = await openDetail(ownerCtx, htmlId)

    const cardExists = !!(await htmlPage.$('#html-preview-card'))
    check('HTML preview card is shown to the owner', cardExists)

    const toggleExists = !!(await htmlPage.$('#html-preview-toggle'))
    check('OFF/ON toggle is present', toggleExists)

    const bodyText = (await htmlPage.textContent('#html-preview-body').catch(() => '')) ?? ''
    check('state reads as OFF by default', /Interactive Preview is\s*OFF/i.test(bodyText.replace(/\s+/g, ' ')), bodyText.slice(0, 120))
    check('toggle is labelled to enable', /Enable Interactive Preview/i.test(bodyText), bodyText.slice(0, 120))
    check(
      'copy states Safe Preview is the default',
      /Safe Preview is the default/i.test(bodyText),
      bodyText.slice(0, 160)
    )

    // The iframe must be Safe now, and descriptor-driven.
    const iframeBefore = await htmlPage.$('iframe.preview-frame')
    if (iframeBefore) {
      const sb = (await iframeBefore.getAttribute('sandbox')) ?? ''
      const src = (await iframeBefore.getAttribute('src')) ?? ''
      check('Safe iframe grants no scripting', !/allow-scripts/.test(sb), `sandbox="${sb}"`)
      check('Safe iframe does not use the preview origin', !src.startsWith(PREVIEW), src)
      check('Safe iframe src is the descriptor fallback', src.includes('/preview'), src)
    } else {
      check('safe iframe present', false, 'no iframe.preview-frame found')
    }

    // ---------------------------------------------------------
    section('Owner · warning before enabling')
    // ---------------------------------------------------------
    await htmlPage.click('#html-preview-toggle')
    await htmlPage.waitForSelector('#sheet-title', { timeout: 5000 }).catch(() => {})

    const sheetTitle = (await htmlPage.textContent('#sheet-title').catch(() => '')) ?? ''
    check('a confirmation sheet appears', /Enable Interactive Preview/i.test(sheetTitle), sheetTitle)

    const sheetBody = (await htmlPage.textContent('#sheet-body').catch(() => '')) ?? ''
    check('warning mentions JavaScript will run', /JavaScript/i.test(sheetBody), sheetBody.slice(0, 140))
    check('warning mentions isolation from session/library data', /session|library data/i.test(sheetBody), sheetBody.slice(0, 160))
    check('warning mentions network stays blocked', /Network requests stay blocked|blocked/i.test(sheetBody), sheetBody.slice(0, 160))
    check('warning mentions external libraries will not work', /librar/i.test(sheetBody), sheetBody.slice(0, 160))

    const primaryLabel =
      (await htmlPage.textContent('#sheet-actions .btn-primary').catch(() => '')) ?? ''
    check('primary action confirms the change', /Enable Interactive Preview/i.test(primaryLabel), primaryLabel)
    check(
      'a safe alternative action is offered',
      /Keep Safe Preview/i.test((await htmlPage.textContent('#sheet-actions').catch(() => '')) ?? '')
    )

    // ---------------------------------------------------------
    section('Owner · confirm enables and the UI reflects it')
    // ---------------------------------------------------------
    await htmlPage.click('#sheet-actions .btn-primary')
    await htmlPage.waitForTimeout(2500)

    const afterToggle = await htmlPage.$('iframe.preview-frame')
    const sbAfter = afterToggle ? ((await afterToggle.getAttribute('sandbox')) ?? '') : ''
    const srcAfter = afterToggle ? ((await afterToggle.getAttribute('src')) ?? '') : ''
    check(
      'iframe switches to the interactive sandbox after enabling',
      /allow-scripts/.test(sbAfter),
      `sandbox="${sbAfter}"`
    )
    check('iframe omits allow-same-origin', !/allow-same-origin/.test(sbAfter), sbAfter)
    check('iframe src moves to the isolated preview origin', srcAfter.startsWith(PREVIEW), srcAfter.slice(0, 60))

    const bodyAfter = ((await htmlPage.textContent('#html-preview-body').catch(() => '')) ?? '').replace(/\s+/g, ' ')
    check('card state reads as ON', /Interactive Preview is\s*ON/i.test(bodyAfter), bodyAfter.slice(0, 140))

    // Server agrees.
    const detail = await (await ownerCtx.request.get(`${APP}/api/v1/artifacts/${htmlId}`)).json()
    check('server reports INTERACTIVE', detail?.data?.artifact?.preview?.mode === 'INTERACTIVE')

    // ---------------------------------------------------------
    section('Owner · disable returns to Safe')
    // ---------------------------------------------------------
    await htmlPage.click('#html-preview-toggle')
    await htmlPage.waitForTimeout(2000)

    const detailOff = await (await ownerCtx.request.get(`${APP}/api/v1/artifacts/${htmlId}`)).json()
    check('server reports SAFE again', detailOff?.data?.artifact?.preview?.mode === 'SAFE')

    const iframeOff = await htmlPage.$('iframe.preview-frame')
    const sbOff = iframeOff ? ((await iframeOff.getAttribute('sandbox')) ?? '') : '(missing)'
    check('iframe returns to the no-script sandbox', !/allow-scripts/.test(sbOff), `sandbox="${sbOff}"`)
    await htmlPage.close()

    // ---------------------------------------------------------
    section('Owner · non-HTML artifact has no control')
    // ---------------------------------------------------------
    const txtPage = await openDetail(ownerCtx, pdfId, { waitForCard: false })
    await txtPage.waitForTimeout(1500)
    check('no HTML preview card for a non-HTML artifact', !(await txtPage.$('#html-preview-card')))
    check('no OFF/ON toggle for a non-HTML artifact', !(await txtPage.$('#html-preview-toggle')))
    await txtPage.close()

    // ---------------------------------------------------------
    section('Non-owner · control is hidden')
    // ---------------------------------------------------------
    // Make the artifact readable by a second user without update rights.
    const viewerCtx = await loginAs(browser, VIEWER)

    const workspaces = await (await ownerCtx.request.get(`${APP}/api/v1/workspaces`)).json()
    const wsId = workspaces?.data?.workspaces?.[0]?.id
    const add = await ownerCtx.request.post(`${APP}/api/v1/workspaces/${wsId}/members`, {
      data: { email: VIEWER, role: 'VIEWER' }
    })
    // 409 means the viewer is already a member from an earlier run; that is the
    // same end state the assertion wants, so it is a pass, not a failure.
    check(
      'viewer is a workspace member (added or already present)',
      [200, 201, 409].includes(add.status()),
      `status=${add.status()}`
    )

    const viewerDetail = await (await viewerCtx.request.get(`${APP}/api/v1/artifacts/${htmlId}`)).json()
    check('viewer can read the artifact', viewerDetail?.ok === true, JSON.stringify(viewerDetail).slice(0, 160))
    check('viewer is NOT reported as canUpdate', viewerDetail?.data?.artifact?.canUpdate === false, String(viewerDetail?.data?.artifact?.canUpdate))

    const viewerPage = await openDetail(viewerCtx, htmlId, { waitForCard: false })
    await viewerPage.waitForTimeout(1500)
    check('viewer sees no HTML preview card', !(await viewerPage.$('#html-preview-card')))
    check('viewer sees no toggle', !(await viewerPage.$('#html-preview-toggle')))

    const viewerWrite = await viewerCtx.request.put(`${APP}/api/v1/artifacts/${htmlId}/preview-settings`, {
      data: { interactiveHtml: true }
    })
    check('viewer cannot enable Interactive via the API', viewerWrite.status() === 403, `status=${viewerWrite.status()}`)
    await viewerPage.close()

    await viewerCtx.close()
    await ownerCtx.close()
  } finally {
    await browser.close()
  }

  console.log('\n' + '='.repeat(60))
  console.log(`${pass} passed, ${fail} failed`)
  if (fail) {
    console.log('\nFAILED CHECKS:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log('ALL PREVIEW UI TESTS PASSED')
}

main().catch((err) => {
  console.error('\nSUITE ERROR:', err?.message ?? err)
  process.exit(1)
})
