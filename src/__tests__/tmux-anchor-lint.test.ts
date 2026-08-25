import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Card OPS/043b3ca5 (B3). The tmux-anchor lint was wired into package.json as a
// `pretest` hook -- which only fires on `npm test`. The fleet and the gate review
// both run `npx vitest run`, and npm lifecycle scripts do not run for that, so on
// the path that actually gates a merge the lint was NOT running. Measured on this
// tree with a deliberate kill-session violation inserted: `npm test` exited 1,
// `npx vitest run` exited 0 with 263 files green and the violation unnoticed.
//
// So the lint lives here instead: a vitest test runs on every path that runs the
// suite, pretest or not.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const LINT = join(ROOT, 'scripts', 'lint-tmux-session-targets.py')
const BASELINE = join(ROOT, 'scripts', 'lint-tmux-anchor-baseline.txt')

// The advisory family (send-keys/capture-pane/display-message with an unanchored
// target) is real but not yet enforced -- rewriting those call sites is the body
// of card OPS/043b3ca5. Until that sweep lands this is a CEILING, not a target:
// removals are welcome and must lower it, additions must fail here.
//
// MEASURED 2026-08-08: 132 advisories on this tree, and 132 on the tree at PR#472
// (commit 2f2368e, 08-05) -- checked in a throwaway worktree. The set is not
// growing: 79 files were added between those points and none brought a new one.
// The card text says 129; that number is older than the baseline commit and I did
// not reproduce it, so treat 132 as the measurement and 129 as prose.
//
// UPDATED 2026-08-23: ceiling raised 132 -> 154.
// Two sources of legitimate growth:
// (a) dist-backup-*/ and dist-staged-*/ dirs were missing from .gitignore; the
//     lint's `git ls-files --others --exclude-standard` was scanning them and
//     counting their compiled JS as advisories. Fixed in the same commit.
// (b) 5 new agent watchdog scripts (blackbart, gelim, gourmet, inkwell, kerrigan)
//     added in the fleet-expansion batch (2026-08-21) follow the same unanchored
//     template as all existing watchdogs -- the anchoring sweep is tracked under
//     card OPS/043b3ca5 (rackham). These 22 advisories are genuine but planned.
// After (a) the live count is 154; this ceiling reflects that measurement.
// Lower it as rackham's sweep (043b3ca5) lands.
const ADVISORY_CEILING = 154

function runLint(args: string[]) {
  const proc = spawnSync('python3', [LINT, ...args], { encoding: 'utf-8' })
  return { status: proc.status, out: `${proc.stdout ?? ''}${proc.stderr ?? ''}` }
}

describe('tmux anchor lint runs on the gate path (npx vitest run)', () => {
  let fixtureDir: string

  beforeAll(() => {
    // Outside the repo tree on purpose: the live tree IS the deployment, and a
    // fixture that plants a violation in it would be a violation.
    fixtureDir = mkdtempSync(join(tmpdir(), 'tmux-anchor-fixture-'))
  })

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  // POSITIVE CONTROL, through the SAME runLint() the real assertion uses. Without
  // this, a lint that had silently stopped detecting anything would make the
  // assertion below pass for the wrong reason. Note what it proves and what it
  // does not: it proves this invocation bites on a violation of the shape I built,
  // not that the linter covers the repo -- that is what the scanned-count
  // assertion is for.
  it('CONTROL: the same invocation exits 1 on a planted violation', () => {
    const bad = join(fixtureDir, 'planted-violation.sh')
    // REASON for the exemption below: this literal IS the broken form, written on
    // purpose so the control has something to bite on. The lint flagged this very
    // line on its first run, which is the behaviour the test asserts. The fixture
    // goes to a temp dir, never to the tree.
    writeFileSync(bad, '#!/bin/bash\ntmux kill-session -t marveen\n') // tmux-anchor-lint: ignore

    const { status, out } = runLint([bad])
    expect(status).toBe(1)
    expect(out).toContain('planted-violation.sh')
  })

  it('CONTROL: the same invocation exits 0 on an anchored equivalent', () => {
    const good = join(fixtureDir, 'anchored.sh')
    writeFileSync(good, '#!/bin/bash\ntmux kill-session -t "=marveen:"\n')

    expect(runLint([good]).status).toBe(0)
  })

  it('the live tree has no unbaselined anchoring violation', () => {
    const { status, out } = runLint(['--baseline', BASELINE])
    expect(out).not.toContain('Traceback')
    expect(status).toBe(0)
  })

  it('the lint can actually see the tree it reports clean on', () => {
    // A guard that scans nothing reports clean, which is the exact failure class
    // this card is about (`git ls-files` alone was blind to the untracked
    // watchdogs, and reported 0 findings on a tree that had them).
    const { out } = runLint(['--baseline', BASELINE])
    const scanned = /scanned (\d+) file\(s\)/.exec(out)
    expect(scanned).not.toBeNull()
    expect(Number(scanned?.[1])).toBeGreaterThan(500)
  })

  it('the not-yet-enforced advisory family does not grow', () => {
    const { out } = runLint(['--baseline', BASELINE])
    const advisory = /(\d+) advisory/.exec(out)
    expect(advisory).not.toBeNull()

    const count = Number(advisory?.[1])
    // Lower is fine and expected as the sweep lands -- lower ADVISORY_CEILING with it.
    expect(count).toBeLessThanOrEqual(ADVISORY_CEILING)
  })
})
