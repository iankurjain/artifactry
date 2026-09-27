/**
 * Extraction harness.
 *
 * The extractors use DecompressionStream / Blob / TextDecoder, all of which
 * exist in the Workers runtime and in Node 22 — so the module is bundled
 * verbatim and exercised against real OOXML and PDF fixtures, rather than
 * being re-implemented for the test.
 */
import { build } from 'esbuild'
import { readFileSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

mkdirSync('/tmp/build', { recursive: true })

await build({
  entryPoints: ['src/lib/extract.ts'],
  outfile: '/tmp/build/extract.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'error'
})

const { extractText } = await import(pathToFileURL('/tmp/build/extract.mjs').href)

const fx = (name) => new Uint8Array(readFileSync(`/tmp/fx/${name}`))

let failures = 0
const check = (label, condition, detail = '') => {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures++
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const show = (r) => {
  const t = (r.text || '').replace(/\n/g, ' ⏎ ').slice(0, 110)
  return `ok=${r.ok} supported=${r.supported} chars=${r.text?.length ?? 0} via=${r.via ?? '-'}\n         text: ${t || '(none)'}\n         note: ${r.note}`
}

console.log('\n=== HTML ===')
{
  const r = await extractText('html', new TextEncoder().encode(
    '<html><head><style>p{color:red}</style><script>alert(1)</script></head>' +
    '<body><h1>Design System</h1><p>Tokens &amp; themes</p></body></html>'
  ))
  console.log(show(r))
  check('html extracts visible text', r.ok && /Design System/.test(r.text))
  check('html drops <script>', !/alert/.test(r.text))
  check('html drops <style>', !/color:red/.test(r.text))
  check('html decodes &amp;', /Tokens & themes/.test(r.text))
}

console.log('\n=== DOCX (simple) ===')
{
  const r = await extractText('docx', fx('simple.docx'))
  console.log(show(r))
  check('docx ok', r.ok)
  check('docx paragraph 1', /Hello Artifact Library/.test(r.text))
  check('docx paragraph 2', /This is a DOCX body paragraph/.test(r.text))
  check('docx newline between paragraphs', r.text.includes('\n'))
}

console.log('\n=== DOCX (multi-run, br, tab, entities) ===')
{
  const r = await extractText('docx', fx('multirun.docx'))
  console.log(show(r))
  check('split runs join without space injection', /Quarterly Revenue/.test(r.text), 'runs are one word')
  check('<w:br/> becomes a line break', /Quarterly Revenue\nTotal/.test(r.text))
  check('<w:tab/> becomes spacing', /Total\s+1,250,000/.test(r.text))
  check('entities decoded', /Escaped & entities <ok>/.test(r.text))
}

console.log('\n=== PPTX ===')
{
  const r = await extractText('pptx', fx('deck.pptx'))
  console.log(show(r))
  check('pptx ok', r.ok)
  check('slide 1 text', /Artifact Library Roadmap/.test(r.text))
  check('slide 2 text', /Semantic Search via Vectorize/.test(r.text))
  check('slide markers present', /\[Slide 1\]/.test(r.text) && /\[Slide 2\]/.test(r.text))
  check('slide order preserved', r.text.indexOf('Roadmap') < r.text.indexOf('Vectorize'))
}

console.log('\n=== PDF (FlateDecode text layer) ===')
{
  const r = await extractText('pdf', fx('text.pdf'))
  console.log(show(r))
  check('pdf ok', r.ok)
  check('pdf line 1', /Hello Artifact Library/.test(r.text))
  check('pdf line 2', /PDF extraction works/.test(r.text))
  check('pdf line 3', /Third line of text/.test(r.text))
  check('pdf lines are separated', r.text.split('\n').length >= 3)
}

console.log('\n=== PDF (no readable text layer -> PARTIAL, not an error) ===')
{
  const r = await extractText('pdf', fx('emptypdf.pdf'))
  console.log(show(r))
  check('reports supported (format understood)', r.supported === true)
  check('reports ok=false', r.ok === false)
  check('gives a reason', /no text|no text layer|scanned/i.test(r.note))
  check('does not throw', true)
}

console.log('\n=== Unsupported type (PNG) -> SKIPPED ===')
{
  const r = await extractText('png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  console.log(show(r))
  check('png not supported', r.supported === false)
  check('still searchable note', /title, filename, description and tags/.test(r.note))
}

console.log('\n=== Malformed inputs must not throw ===')
for (const [name, bytes] of [
  ['truncated zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])],
  ['garbage docx', new TextEncoder().encode('this is not a zip file at all')],
  ['empty', new Uint8Array(0)],
  ['random pdf', new TextEncoder().encode('%PDF-1.4\nnot really structured%%EOF')]
]) {
  let threw = null
  let r = null
  try {
    r = await extractText(name.includes('pdf') ? 'pdf' : 'docx', bytes)
  } catch (e) {
    threw = e
  }
  check(`${name}: no throw`, !threw, threw ? String(threw) : '')
  if (r) check(`${name}: returns a result`, typeof r.ok === 'boolean', r.note.slice(0, 60))
}

console.log(`\n${failures === 0 ? 'ALL EXTRACTION TESTS PASSED' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
