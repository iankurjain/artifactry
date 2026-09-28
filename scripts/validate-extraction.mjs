/**
 * Real-document extraction validation.
 *
 * Runs the shipped extractors (src/lib/extract.ts, bundled with esbuild) against
 * the generated validation set in /tmp/val and reports what was actually
 * recovered — including failures. The hand-written PDF parser is best-effort:
 * this script exists to measure that honestly rather than to assert full support.
 *
 * Exit code is non-zero only if a fixture that MUST yield text yields none, or a
 * fixture that must NOT yield text yields some. `expect: "maybe"` cases (embedded
 * CID fonts, object streams) are reported but never fail the run.
 *
 * Usage:
 *   python3 scripts/gen-extraction-fixtures.py /tmp/val
 *   node scripts/validate-extraction.mjs [dir]
 */

import { build } from 'esbuild'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIR = process.argv[2] ?? '/tmp/val'

mkdirSync('/tmp/build', { recursive: true })
await build({
  entryPoints: ['src/lib/extract.ts'],
  outfile: '/tmp/build/extract-val.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'error'
})

const { extractText } = await import(pathToFileURL('/tmp/build/extract-val.mjs').href)

const manifestPath = join(DIR, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error(`No manifest at ${manifestPath}.`)
  console.error('Run: python3 scripts/gen-extraction-fixtures.py ' + DIR)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

let mustFail = 0
let unexpected = 0

console.log('Real-document extraction validation')
console.log(`fixtures: ${DIR}`)
console.log(`cases:    ${manifest.length}\n`)

const rows = []

for (const entry of manifest) {
  const path = join(DIR, entry.file)
  if (!existsSync(path)) {
    console.log(`MISSING  ${entry.file}`)
    mustFail++
    continue
  }

  const bytes = new Uint8Array(readFileSync(path))
  const ext = entry.file.split('.').pop().toLowerCase()

  let result
  try {
    result = await extractText(ext, bytes)
  } catch (err) {
    console.log(`THREW    ${entry.file} — ${err}`)
    mustFail++
    continue
  }

  const text = result.text ?? ''
  const recovered = text.length
  const found = entry.expectContains.filter((needle) => text.includes(needle))
  const missing = entry.expectContains.filter((needle) => !text.includes(needle))

  let verdict
  if (entry.expect === 'text') {
    if (recovered > 0 && !missing.length) verdict = 'PASS'
    else if (recovered > 0) verdict = 'PARTIAL'
    else verdict = 'FAIL'
    if (verdict !== 'PASS') mustFail++
  } else if (entry.expect === 'no-text') {
    verdict = recovered === 0 ? 'PASS' : 'UNEXPECTED-TEXT'
    if (verdict !== 'PASS') unexpected++
  } else {
    // Best-effort case: report only, never fail the build.
    verdict = recovered > 0 ? 'RECOVERED' : 'NOT-DECODED'
  }

  const status =
    verdict === 'PASS' ? 'ok  ' :
    verdict === 'RECOVERED' ? 'info' :
    verdict === 'PARTIAL' ? 'WARN' : 'FAIL'

  console.log(`${status} ${entry.file}`)
  console.log(`     generator : ${entry.generator}`)
  console.log(`     state     : supported=${result.supported} ok=${result.ok} chars=${recovered} via=${result.via ?? '-'}`)
  console.log(`     note      : ${result.note}`)
  if (found.length) console.log(`     matched   : ${found.map((f) => JSON.stringify(f)).join(', ')}`)
  if (missing.length) console.log(`     MISSING   : ${missing.map((f) => JSON.stringify(f)).join(', ')}`)
  if (verdict === 'PARTIAL' || verdict === 'FAIL' || verdict === 'NOT-DECODED') {
    console.log(`     excerpt   : ${JSON.stringify(text.slice(0, 160))}`)
  }
  console.log()

  rows.push({ file: entry.file, generator: entry.generator, verdict, chars: recovered, expect: entry.expect, via: result.via ?? null })
}

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------

console.log('='.repeat(64))
console.log('verdict             chars  generator')
for (const r of rows) {
  console.log(`${r.verdict.padEnd(20)}${String(r.chars).padStart(6)}  ${r.generator}`)
}

const byState = rows.reduce((acc, r) => {
  const key = r.expect === 'maybe' ? 'best-effort' : r.expect
  acc[key] = acc[key] ?? {}
  acc[key][r.verdict] = (acc[key][r.verdict] ?? 0) + 1
  return acc
}, {})

console.log()
console.log('Summary by expectation:', JSON.stringify(byState))

const notDecoded = rows.filter((r) => r.verdict === 'NOT-DECODED')
if (notDecoded.length) {
  console.log()
  console.log('Best-effort PDF cases that were NOT decoded (this is the honest limit of')
  console.log('the hand-written parser — these are NOT claimed as supported):')
  for (const r of notDecoded) console.log(`  - ${r.file}  (${r.generator})`)
}

console.log()
if (mustFail || unexpected) {
  console.log(`VALIDATION FAILED — ${mustFail} required case(s) failed, ${unexpected} unexpected-text case(s)`)
  process.exit(1)
}
console.log('VALIDATION PASSED — every required case behaved as specified')
