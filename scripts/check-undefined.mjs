/**
 * Undefined-identifier checker.
 *
 * Motivation: the bundler and `check-imports.mjs` both miss one specific and
 * repeatedly-observed failure mode.
 *
 *   - `check-imports.mjs` verifies that names we DO import exist as exports.
 *   - The bundler resolves every import it is given.
 *   - Neither notices a name that is USED but never imported at all. In ESM
 *     that is a syntactically valid reference to an ambient global, so the
 *     build succeeds and the module only explodes at runtime with
 *     `X is not defined`.
 *
 * That is how `verifiedGrantFor` and `previewSandbox` both shipped past a green
 * build and a passing test suite. This script closes the gap.
 *
 * Strategy: a project symbol may only be referenced by a module that imports it
 * or declares it locally. Only *runtime* exports are considered (functions,
 * const/let/var, classes, enums) — `type`/`interface` are erased and cannot
 * cause a runtime ReferenceError.
 *
 * Deliberately heuristic, but tuned to be quiet: it only ever complains about
 * identifiers that some module in this repo really exports, so globals
 * (`fetch`, `crypto`, `URL`, ...) never produce noise.
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.git', '.wrangler', 'dist'].includes(entry.name)) continue
      walk(full, out)
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'public'))]

/** Runtime exports only — these are the ones that can throw at runtime. */
function collectRuntimeExports(source) {
  const names = new Set()
  const declRe =
    /export\s+(?:async\s+)?(?:function\*?|class|const|let|var|enum)\s+([A-Za-z0-9_$]+)/g
  let m
  while ((m = declRe.exec(source))) names.add(m[1])
  return names
}

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js')
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Remove comments and string/template bodies so a name mentioned in prose or in
 * a CSS selector never registers as a reference.
 */
function sanitize(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** Everything the module can legitimately reference without importing it. */
function collectLocals(source) {
  const names = new Set()

  const declRe = /\b(?:function\*?|class|const|let|var|enum|interface|type)\s+([A-Za-z0-9_$]+)/g
  let m
  while ((m = declRe.exec(source))) names.add(m[1])

  // import { a, b as c } from '...'
  const namedImport = /import\s+(?:type\s+)?\{([^}]*)\}/g
  while ((m = namedImport.exec(source))) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim().replace(/^type\s+/, '')
      if (!part) continue
      const as = part.split(/\s+as\s+/)
      names.add(as[as.length - 1].trim())
    }
  }

  // import Default, { .. } / import Default from
  const defImport = /import\s+([A-Za-z0-9_$]+)\s*(?:,|from)/g
  while ((m = defImport.exec(source))) names.add(m[1])

  // import * as ns
  const nsImport = /import\s+\*\s+as\s+([A-Za-z0-9_$]+)/g
  while ((m = nsImport.exec(source))) names.add(m[1])

  // Parameters of arrow functions and function declarations, so a parameter
  // that shadows a project symbol is not mistaken for a missing import.
  const paramLists = /\(([^()]*)\)\s*(?:=>|\{)|(?:function\s*[A-Za-z0-9_$]*\s*)\(([^()]*)\)/g
  while ((m = paramLists.exec(source))) {
    for (const chunk of [m[1], m[2]]) {
      if (!chunk) continue
      for (const raw of chunk.split(',')) {
        const part = raw.trim().replace(/^\.\.\./, '')
        if (!/^[A-Za-z0-9_$]+$/.test(part)) continue
        names.add(part)
      }
    }
  }

  // Destructuring in declarations: const { a, b } = / const [a, b] =
  const destruct = /\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g
  while ((m = destruct.exec(source))) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim().split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '')
      if (/^[A-Za-z0-9_$]+$/.test(part)) names.add(part)
    }
  }

  // Property keys (`foo:` inside an object literal) and inline type
  // annotations (`{ name: string }`, `fn(a: string)`) share the `name:`
  // shape. Neither is an identifier reference, so both are safe to ignore.
  const keys = /(?:^|[\s,{([])([A-Za-z_$][A-Za-z0-9_$]*)\s*[?:]\s*[^:]/gm
  while ((m = keys.exec(source))) names.add(m[1])

  return names
}

const exportsByFile = new Map()
const projectSymbols = new Map() // name -> Set of files exporting it

for (const file of files) {
  const exported = collectRuntimeExports(fs.readFileSync(file, 'utf8'))
  exportsByFile.set(file, exported)
  for (const name of exported) {
    if (!projectSymbols.has(name)) projectSymbols.set(name, new Set())
    projectSymbols.get(name).add(file)
  }
}

/**
 * Names that are real project exports but are referenced by another module only
 * as English text or an HTML fragment, never as an identifier. Each entry is a
 * deliberate, reviewed exception — keep this list empty whenever possible.
 */
const IGNORED = new Set([
  // screens.js renders the literal label "See all" and an element id of
  // `home-all`; the word "all" also collides with `all()` in lib/db.ts.
  'all'
])

const problems = []

for (const file of files) {
  const source = sanitize(fs.readFileSync(file, 'utf8'))
  const locals = collectLocals(source)
  const ownExports = exportsByFile.get(file) ?? new Set()

  for (const [name, exporters] of projectSymbols) {
    if (name.length < 3) continue
    if (IGNORED.has(name)) continue
    if (locals.has(name) || ownExports.has(name)) continue
    // Only complain when the name is genuinely referenced. Excluded:
    //   `obj.name`      property access
    //   `/api/v1`       a URL path segment, not an identifier
    const refRe = new RegExp(`(^|[^./\\w$])${name}\\b`, 'm')
    if (!refRe.test(source)) continue
    problems.push({
      file: path.relative(ROOT, file),
      name,
      from: [...exporters].map((f) => path.relative(ROOT, f)).join(', ')
    })
  }
}

if (problems.length) {
  console.log(`POSSIBLY-UNDEFINED IDENTIFIERS (${problems.length}):`)
  for (const p of problems) {
    console.log(`  ${p.name}  — referenced by ${p.file}, exported by ${p.from}`)
  }
  process.exit(1)
}

console.log('No project symbols are referenced without an import or local declaration.')
