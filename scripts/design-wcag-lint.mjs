#!/usr/bin/env node
/*
 * Non-blocking WCAG-contrast + structural lint for the NoA DESIGN.md (card 57c4b3b4).
 *
 * PILOT of @google/design.md (meeting 06-30, Dave+BigBen+Radar convergence). The
 * value is the WCAG-contrast lint, NOT token export: our tokens.css is already the
 * single source of truth and stays so. This runner surfaces the design.md CLI's
 * structured findings (broken token references + WCAG AA contrast failures) as an
 * OBSERVABILITY check. It is intentionally NON-BLOCKING: it always exits 0 so an
 * upstream lint regression or a contrast warning never bricks the build. A future
 * card can promote structural errors to blocking once the pilot has proven out.
 *
 * Runs dev/CI-time only, fully offline (no network egress from the CLI).
 * Usage: node scripts/design-wcag-lint.mjs [path/to/DESIGN.md]
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DESIGN_MD = process.argv[2] || join(ROOT, 'dashboard-new', 'DESIGN.md')
const CLI = join(ROOT, 'node_modules', '@google', 'design.md', 'dist', 'index.js')

function main() {
  if (!existsSync(DESIGN_MD)) {
    console.error(`[design-wcag-lint] DESIGN.md not found at ${DESIGN_MD} -- skipping (non-blocking).`)
    return 0
  }
  if (!existsSync(CLI)) {
    console.error('[design-wcag-lint] @google/design.md not installed -- skipping (non-blocking).')
    return 0
  }

  let report
  try {
    const out = execFileSync('node', [CLI, 'lint', '--format', 'json', DESIGN_MD], { encoding: 'utf-8' })
    report = JSON.parse(out)
  } catch (err) {
    // The CLI exits non-zero when it finds errors; it still prints the JSON report
    // on stdout, so parse that. Only fall back to a soft skip if there is no output.
    const stdout = err?.stdout?.toString?.() ?? ''
    try {
      report = JSON.parse(stdout)
    } catch {
      console.error(`[design-wcag-lint] lint could not run -- skipping (non-blocking): ${err?.message ?? err}`)
      return 0
    }
  }

  const findings = report.findings ?? []
  const s = report.summary ?? { errors: 0, warnings: 0, infos: 0 }
  const contrastFailures = findings.filter(
    (f) => typeof f.message === 'string' && /contrast ratio .*below WCAG/i.test(f.message),
  )
  const structuralErrors = findings.filter((f) => f.severity === 'error')

  console.log(`[design-wcag-lint] ${DESIGN_MD}`)
  console.log(`[design-wcag-lint] errors=${s.errors ?? 0} warnings=${s.warnings ?? 0} infos=${s.infos ?? 0}`)

  for (const f of structuralErrors) {
    console.log(`  ERROR    ${f.path ?? ''} :: ${f.message}`)
  }
  for (const f of contrastFailures) {
    console.log(`  CONTRAST ${f.path ?? ''} :: ${f.message}`)
  }
  if (structuralErrors.length === 0 && contrastFailures.length === 0) {
    console.log('  OK: no structural errors, no WCAG AA contrast failures.')
  } else {
    console.log(
      `  NOTE: ${structuralErrors.length} error(s), ${contrastFailures.length} contrast failure(s) ` +
        '-- reported for visibility, NOT failing the build (non-blocking pilot).',
    )
  }

  // Non-blocking: always succeed.
  return 0
}

process.exit(main())
