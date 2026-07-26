// Invariant lint test.
// Enforces the 5th invariant: no source-specific assumptions are allowed
// outside source adapters. Scans src/lib/*.js (shared pipeline code) for:
//   - source identity checks (source === "nyaa", if (tracker === "..."), etc.)
//   - release group checks (releaseGroup === "Rojima", etc.)
// These belong inside src/{nyaa,animetosho,...}.js adapters only.
//
// Run: npm run test:invariants

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let LIB_DIR = new URL('../src/lib', import.meta.url).pathname
if (LIB_DIR.startsWith('/')) LIB_DIR = LIB_DIR.slice(1)
// Drive letter fix: "C:" may appear as "/C:" from URL on Windows
if (/^[A-Za-z]:/i.test(LIB_DIR)) LIB_DIR = LIB_DIR.replace(/^\//, '')

function lineOf (src, needle) {
  const idx = src.indexOf(needle)
  if (idx < 0) return 0
  return (src.slice(0, idx).match(/\n/g) || []).length + 1
}

async function scanDir (dir, kind) {
  const entries = await readdir(dir)
  const errors = []
  for (const fn of entries) {
    if (!fn.endsWith('.js')) continue
    const path = join(dir, fn)
    const src = await readFile(path, 'utf8')

    // forbid source identity checks
    const srcMatch = src.match(/\bsource\s*[=!]==\s*["'][a-z]+["']/gi)
    if (srcMatch) for (const m of srcMatch) errors.push({ file: kind + '/' + fn, line: lineOf(src, m), match: m, rule: 'source-identity-check' })

    // forbid tracker field comparisons in lib/ (metadata passthrough is OK)
    // We specifically target identity-equality checks, not metadata reads
    const trackerIdentity = src.match(/\.tracker\s*[=!]==\s*["']/gi)
    if (trackerIdentity) for (const m of trackerIdentity) errors.push({ file: kind + '/' + fn, line: lineOf(src, m), match: m, rule: 'tracker-identity-check' })
    // Also check: tracker field used in switch/case/if branching by tracker name
    const trackerSwitch = src.match(/\.tracker\s*===\s*["'][a-z0-9]+["']/gi)
    if (trackerSwitch) for (const m of trackerSwitch) errors.push({ file: kind + '/' + fn, line: lineOf(src, m), match: m, rule: 'tracker-identity-check' })

    // forbid releaseGroup identity checks in lib/
    if (kind === 'lib/') {
      const groupMatch = src.match(/releaseGroup\s*[=!]==\s*["'][a-z0-9]+["']/gi)
      if (groupMatch) for (const m of groupMatch) errors.push({ file: kind + '/' + fn, line: lineOf(src, m), match: m, rule: 'release-group-identity-check' })
    }
  }
  return errors
}

console.log('================ INVARIANT LINT ================')
console.log('scanned:', LIB_DIR)

const errors = await scanDir(LIB_DIR, 'lib/')
console.log('errors:', errors.length)

let failed = false
if (errors.length) {
  console.log('\nviolations:')
  errors.forEach(e => console.log('  ' + e.rule + '  ' + e.file + ':' + e.line + '  ' + e.match))
  console.log('\nFAIL: source-specific assumptions found in shared pipeline code')
  failed = true
} else {
  console.log('ALL PASSED — no source-specific checks in lib/')
}

console.log('\n' + (failed ? 'FAILED' : 'PASSED'))
process.exit(failed ? 1 : 0)