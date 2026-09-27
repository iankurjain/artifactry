/**
 * Static import/export consistency checker.
 *
 * The bundler reports one missing export at a time, which makes iterating slow.
 * This walks every TS/JS module, collects its exported names, then verifies that
 * every named import actually exists in the module it points at.
 *
 * Only relative specifiers are checked — bare specifiers (hono, vite) are
 * resolved by the bundler and are not our concern here.
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.wrangler') continue
      walk(full, out)
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** Both src/ and public/static/ contain hand-written modules worth checking. */
const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'public'))]

function collectExports(source) {
  const names = new Set()

  const declRe = /export\s+(?:async\s+)?(?:function\*?|class|const|let|var|enum|interface|type)\s+([A-Za-z0-9_$]+)/g
  let m
  while ((m = declRe.exec(source))) names.add(m[1])

  // export { a, b as c } / export type { ... }
  const listRe = /export\s+(?:type\s+)?\{([^}]*)\}/g
  while ((m = listRe.exec(source))) {
    for (const part of m[1].split(',')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const aliased = trimmed.split(/\s+as\s+/)
      names.add(aliased[aliased.length - 1].trim())
    }
  }

  if (/export\s+default\b/.test(source)) names.add('default')

  return names
}

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js')
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

const exportsByFile = new Map()
for (const file of files) {
  exportsByFile.set(file, collectExports(fs.readFileSync(file, 'utf8')))
}

const problems = []
const unresolved = []

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8')

  // Static named imports (skip dynamic import() and side-effect-only imports)
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  let m
  while ((m = importRe.exec(source))) {
    const spec = m[2]
    const target = resolveSpecifier(file, spec)
    if (!target) {
      if (spec.startsWith('.')) unresolved.push(`${path.relative(ROOT, file)} -> ${spec}`)
      continue
    }

    const available = exportsByFile.get(target)
    if (!available) {
      unresolved.push(`${path.relative(ROOT, file)} -> ${spec} (no export table)`)
      continue
    }

    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (!name) continue
      if (!available.has(name)) {
        problems.push({
          file: path.relative(ROOT, file),
          spec,
          name,
          target: path.relative(ROOT, target)
        })
      }
    }
  }
}

if (unresolved.length) {
  console.log('UNRESOLVED RELATIVE MODULES:')
  for (const u of [...new Set(unresolved)]) console.log('  ' + u)
  console.log('')
}

if (problems.length) {
  console.log(`MISSING EXPORTS (${problems.length}):`)
  for (const p of problems) {
    console.log(`  ${p.name}  — imported by ${p.file} from '${p.spec}' (resolved: ${p.target})`)
  }
  process.exit(1)
}

console.log('All relative imports resolve against real exports.')
