/**
 * Auto-tagging regression suite.
 *
 * WHY THIS EXISTS
 * The production defect was not a crash anybody would notice — it was a silent
 * one. `@cf/meta/llama-3.1-8b-instruct` was deprecated on 2026-05-30, Workers AI
 * began answering 5028, `suggestTags` caught the error and returned an empty
 * list, and the upload response looked exactly like a document that genuinely
 * had nothing worth tagging. Auto-tagging was off in production and every
 * signal said "fine".
 *
 * So this suite guards two separate things:
 *
 *   1. The configured model is real and current. A local check against a
 *      known-retired list always runs; a live catalog check runs too when a
 *      Cloudflare token is available, so a *future* deprecation is caught
 *      before it reaches production.
 *   2. Failure is VISIBLE. When the model is unavailable the outcome must carry
 *      `status: 'MODEL_ERROR'` (plus the provider message and a deprecation
 *      flag), never an empty list with a vague note.
 *
 * Everything else here is the guardrail behaviour that must not regress while
 * the model is being changed: 3–7 tags, generic/sensitive filtering,
 * case-insensitive de-duplication.
 *
 * Runs headless: `suggestTags` is pure, so there is no database and no browser.
 *
 * Usage: node scripts/test-autotag.mjs
 *   LIVE=0 node scripts/test-autotag.mjs   # skip the live catalog check
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = process.cwd()
const LIVE = process.env.LIVE !== '0'

let pass = 0
let fail = 0
let skipped = 0
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

/**
 * An explicitly-not-verified result. Used for the live catalog check when no
 * token is present: reported as SKIPPED, never counted as a pass, because the
 * whole point of this suite is that an unverified model must not read as a
 * working one.
 */
function skip(name, why) {
  skipped++
  console.log(`  \u25CB SKIPPED: ${name}  \u2014 ${why}`)
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

async function loadAutotag() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotag-bundle-'))
  const outfile = path.join(tmpDir, 'bundle.mjs')
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/lib/autotag.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

/** A fake Workers AI binding that returns a canned completion. */
function aiReturning(content) {
  return {
    async run() {
      return { response: content }
    }
  }
}

/** A fake Workers AI binding that fails the way a retired model does. */
function aiThrowing(message) {
  return {
    async run() {
      throw new Error(message)
    }
  }
}

const SAMPLE_TEXT =
  'Q3 board deck for EMEA revenue performance. Covers Nordic expansion, customer churn ' +
  'and the renewal pipeline with Acme Corporation in Germany.'

const BASE_INPUT = {
  title: 'Q3 Board Deck EMEA Revenue',
  description: null,
  extension: 'html',
  workspaceName: 'Finance',
  text: SAMPLE_TEXT
}

async function main() {
  const mod = await loadAutotag()
  const { TAGGING_MODEL, DEPRECATED_TAGGING_MODELS, suggestTags, filterSuggestions, blockReason, isDeprecatedModelError } = mod

  // ---------------------------------------------------------------
  // 1. The configured model must be current
  // ---------------------------------------------------------------
  section('Model configuration')

  check('a tagging model is configured', typeof TAGGING_MODEL === 'string' && TAGGING_MODEL.length > 0, String(TAGGING_MODEL))
  check(
    'the configured model is not on the known-retired list',
    !DEPRECATED_TAGGING_MODELS.has(TAGGING_MODEL),
    `TAGGING_MODEL=${TAGGING_MODEL} is retired; update it in src/lib/autotag.ts`
  )
  check(
    'the retired list actually contains the model that broke production',
    DEPRECATED_TAGGING_MODELS.has('@cf/meta/llama-3.1-8b-instruct'),
    'the regression that motivated this suite must stay covered'
  )

  // Live catalog check — the only way to catch a deprecation we do not know
  // about yet. Requires network + a token; reported as SKIPPED otherwise.
  if (!LIVE) {
    skip('the configured model is live in the Workers AI catalog', 'LIVE=0')
  } else {
    const token = process.env.CLOUDFLARE_API_TOKEN
    const account = process.env.CLOUDFLARE_ACCOUNT_ID
    if (!token || !account) {
      skip(
        'the configured model is live in the Workers AI catalog',
        'no CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID in the environment'
      )
    } else {
      try {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search?per_page=200`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        const body = await res.json()
        const models = Array.isArray(body?.result) ? body.result : []
        const entry = models.find((m) => m?.name === TAGGING_MODEL)

        check('the Workers AI catalog is reachable', models.length > 0, `status=${res.status} models=${models.length}`)
        check(
          `the catalog lists ${TAGGING_MODEL}`,
          !!entry,
          entry ? '' : 'the model is absent from the live catalog, so tagging would fail at runtime'
        )
        check(
          `the catalog does not mark ${TAGGING_MODEL} deprecated`,
          !entry?.deprecation,
          entry ? JSON.stringify(entry.deprecation) : 'no catalog entry to inspect'
        )
      } catch (err) {
        // A network failure must not be recorded as a pass.
        check('the Workers AI catalog is reachable', false, String(err?.message ?? err))
      }
    }
  }

  // ---------------------------------------------------------------
  // 2. A retired model must fail VISIBLY
  // ---------------------------------------------------------------
  section('Retired model fails visibly (the production defect)')

  {
    const outcome = await suggestTags(
      { AI: aiThrowing('AiError: 5028: @cf/meta/llama-3.1-8b-instruct was deprecated on 2026-05-30.') },
      BASE_INPUT
    )
    check('status is MODEL_ERROR rather than a silent empty result', outcome.status === 'MODEL_ERROR', String(outcome.status))
    check('the failure is not reported as a successful run', outcome.ran === false, `ran=${outcome.ran}`)
    check('the deprecation is flagged explicitly', outcome.deprecatedModel === true)
    check('the provider message is preserved for diagnostics', typeof outcome.error === 'string' && outcome.error.length > 0)
    check(
      'the note names the model so the cause is unambiguous',
      outcome.note.includes(TAGGING_MODEL),
      outcome.note
    )
    check('no tags are invented on failure', outcome.suggestions.length === 0)
  }

  {
    // A non-deprecation outage is still a visible failure, just less specific.
    const outcome = await suggestTags({ AI: aiThrowing('Network connection lost') }, BASE_INPUT)
    check('an ordinary model outage is also MODEL_ERROR', outcome.status === 'MODEL_ERROR', String(outcome.status))
    check('an ordinary outage is NOT mislabelled as a deprecation', !outcome.deprecatedModel)
  }

  check('error 5028 is recognised as a retirement', isDeprecatedModelError(new Error('AiError: 5028: deprecated')))
  check('a generic error is not treated as a retirement', !isDeprecatedModelError(new Error('Network connection lost')))

  // ---------------------------------------------------------------
  // 3. Healthy paths still work and report their status
  // ---------------------------------------------------------------
  section('Healthy paths')

  {
    const outcome = await suggestTags(
      { AI: aiReturning('["emea revenue","nordic expansion","customer churn","acme corporation"]') },
      BASE_INPUT
    )
    check('status is OK when the model answers', outcome.status === 'OK', String(outcome.status))
    check('the run is reported as having happened', outcome.ran === true)
    check('between 3 and 7 tags are produced', outcome.suggestions.length >= 3 && outcome.suggestions.length <= 7, `n=${outcome.suggestions.length}`)
    check('the model used is reported', outcome.model === TAGGING_MODEL, String(outcome.model))
  }

  {
    const outcome = await suggestTags({ AI: undefined }, BASE_INPUT)
    check('a missing AI binding reports NO_BINDING', outcome.status === 'NO_BINDING', String(outcome.status))
    check('no binding is not reported as a run', outcome.ran === false)
  }

  {
    const outcome = await suggestTags({ AI: aiReturning('["x"]') }, { ...BASE_INPUT, text: '' })
    check('missing extracted text reports NO_TEXT', outcome.status === 'NO_TEXT', String(outcome.status))
  }

  {
    // Model answered, but with nothing usable — distinct from a failure.
    const outcome = await suggestTags({ AI: aiReturning('   ') }, BASE_INPUT)
    check('an unusable model answer reports EMPTY_OUTPUT', outcome.status === 'EMPTY_OUTPUT', String(outcome.status))
  }

  // ---------------------------------------------------------------
  // 4. Guardrails must not regress
  // ---------------------------------------------------------------
  section('Guardrails')

  {
    const { kept, dropped } = filterSuggestions([
      'document', 'report', 'presentation', 'final', 'draft',
      'q3 revenue', 'emea', 'board meeting'
    ])
    check('generic type words are dropped', dropped.length === 5, `dropped=${dropped.join(',')}`)
    check('subject tags survive', kept.includes('q3 revenue') && kept.includes('emea'), kept.join(','))
  }

  {
    const { dropped } = filterSuggestions(['customer churn', 'religion', 'medical history'])
    check('sensitive attributes are refused', dropped.includes('religion') && dropped.includes('medical history'), dropped.join(','))
  }

  {
    const { kept } = filterSuggestions(['AI', 'ai', 'Ai', 'emea', 'nordic'])
    check('case-insensitive de-duplication', kept.filter((t) => t.toLowerCase() === 'ai').length === 1, kept.join(','))
  }

  {
    const { kept } = filterSuggestions(['a', 'b', 'q3 revenue', 'emea', 'nordic', 'churn', 'pipeline', 'renewals', 'acme', 'germany'])
    check('the ceiling is 7 tags', kept.length <= 7, `n=${kept.length}`)
  }

  check('a sensitive manual tag is refused', blockReason('religion') === 'sensitive', String(blockReason('religion')))
  check('an empty manual tag is refused', blockReason('   ') === 'empty')
  check('an ordinary manual tag is allowed', blockReason('board prep') === null, String(blockReason('board prep')))

  console.log('\n' + '='.repeat(60))
  console.log(`  ${pass} passed, ${fail} failed, ${skipped} skipped (not verified)`)
  if (fail > 0) {
    console.log(`  FAILED: ${failures.join(' | ')}`)
    process.exit(1)
  }
  console.log('  AUTO-TAGGING REGRESSION SUITE PASSED')
}

main().catch((err) => {
  console.error('\nSUITE ERROR:', err?.message ?? err)
  process.exit(1)
})
