/**
 * WCAG-contrast lint pilot for the NoA DESIGN.md (card 57c4b3b4).
 *
 * PILOT of @google/design.md (meeting 06-30). The value is the WCAG-contrast lint;
 * tokens.css stays the single source of truth. These tests pin the pilot so a gate
 * run (`npm test`) verifies:
 *   1. the committed DESIGN.md is structurally valid (0 lint errors),
 *   2. the WCAG contrast rule actually has teeth (flags a sub-AA pair),
 *   3. DESIGN.md colors stay in parity with tokens.css (no drift from the source of
 *      truth),
 *   4. the runner is genuinely non-blocking (exit 0 even on a contrast failure).
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const CLI = join(ROOT, 'node_modules/@google/design.md/dist/index.js')
const DESIGN_MD = join(ROOT, 'dashboard-new/DESIGN.md')
const TOKENS_CSS = join(ROOT, 'dashboard-new/styles/tokens.css')
const RUNNER = join(ROOT, 'scripts/design-wcag-lint.mjs')

type Finding = { severity: string; path?: string; message?: string }
type Report = { findings: Finding[]; summary: { errors: number; warnings: number; infos: number } }

// Run the design.md CLI lint and parse the JSON report. The CLI exits non-zero on
// errors but still emits the JSON on stdout, so read it from either place.
function lint(file: string): Report {
  try {
    return JSON.parse(execFileSync('node', [CLI, 'lint', '--format', 'json', file], { encoding: 'utf-8' }))
  } catch (err: any) {
    return JSON.parse(err.stdout.toString())
  }
}

// Parse the `colors:` block of the DESIGN.md YAML front matter into name -> hex.
function designColors(): Record<string, string> {
  const src = readFileSync(DESIGN_MD, 'utf-8')
  const fm = src.split('---')[1] ?? ''
  const out: Record<string, string> = {}
  let inColors = false
  for (const line of fm.split('\n')) {
    if (/^colors:\s*$/.test(line)) { inColors = true; continue }
    if (inColors && /^\S/.test(line)) break // next top-level key ends the block
    const m = inColors && line.match(/^\s+([\w-]+):\s*"(#[0-9a-fA-F]{3,8})"/)
    if (m) out[m[1]] = m[2].toLowerCase()
  }
  return out
}

// Parse tokens.css `--name: #hex;` literals (ignores var() alias references).
function tokenHexes(): Record<string, string> {
  const src = readFileSync(TOKENS_CSS, 'utf-8')
  const out: Record<string, string> = {}
  for (const m of src.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[m[1]] = m[2].toLowerCase()
  }
  return out
}

describe('DESIGN.md WCAG lint pilot (card 57c4b3b4)', () => {
  it('the committed DESIGN.md is structurally valid (0 lint errors)', () => {
    const report = lint(DESIGN_MD)
    const errors = report.findings.filter((f) => f.severity === 'error')
    expect(errors, `unexpected structural errors: ${JSON.stringify(errors)}`).toHaveLength(0)
    expect(report.summary.errors).toBe(0)
  })

  it('the committed DESIGN.md has no WCAG AA contrast failures', () => {
    const report = lint(DESIGN_MD)
    const failures = report.findings.filter((f) => /contrast ratio .*below WCAG/i.test(f.message ?? ''))
    expect(failures, `contrast failures: ${JSON.stringify(failures)}`).toHaveLength(0)
  })

  it('the contrast rule has teeth: a sub-AA pair is flagged below 4.5:1', () => {
    // cyan text on cyan-glow background -- deliberately illegible.
    const fixture = join(ROOT, 'dashboard-new', 'DESIGN.contrast-fixture.md')
    const bad = [
      '---',
      'name: Probe',
      'colors:',
      '  a: "#2fc4ed"',
      '  b: "#53e9ff"',
      'components:',
      '  probe:',
      '    backgroundColor: "{colors.b}"',
      '    textColor: "{colors.a}"',
      '---',
      '## Overview',
      'probe',
      '',
    ].join('\n')
    writeFileSync(fixture, bad, 'utf-8')
    try {
      const report = lint(fixture)
      const contrast = report.findings.filter((f) => /contrast ratio .*below WCAG/i.test(f.message ?? ''))
      expect(contrast.length).toBeGreaterThan(0)
      expect(contrast[0].message).toMatch(/below WCAG AA/i)
    } finally {
      rmSync(fixture, { force: true })
    }
  })

  it('DESIGN.md colors stay in parity with tokens.css (source of truth)', () => {
    const design = designColors()
    const tokens = tokenHexes()
    expect(Object.keys(design).length).toBeGreaterThan(0)
    for (const [name, hex] of Object.entries(design)) {
      expect(tokens[name], `DESIGN.md color '${name}' has no matching --${name} in tokens.css`).toBeDefined()
      expect(hex, `DESIGN.md '${name}'=${hex} drifted from tokens.css --${name}=${tokens[name]}`).toBe(tokens[name])
    }
  })

  it('the runner is non-blocking: exits 0 even when a contrast failure exists', () => {
    const fixture = join(ROOT, 'dashboard-new', 'DESIGN.nonblock-fixture.md')
    const bad = [
      '---', 'name: Probe', 'colors:', '  a: "#2fc4ed"', '  b: "#53e9ff"',
      'components:', '  probe:', '    backgroundColor: "{colors.b}"', '    textColor: "{colors.a}"',
      '---', '## Overview', 'probe', '',
    ].join('\n')
    writeFileSync(fixture, bad, 'utf-8')
    try {
      // execFileSync throws on non-zero exit; a clean return proves exit 0.
      const out = execFileSync('node', [RUNNER, fixture], { encoding: 'utf-8' })
      expect(out).toMatch(/CONTRAST|contrast failure/i)
    } finally {
      rmSync(fixture, { force: true })
    }
  })
})
