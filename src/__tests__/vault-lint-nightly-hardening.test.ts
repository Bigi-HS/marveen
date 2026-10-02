/**
 * Tests for scripts/vault-lint-nightly-full.sh hardening (card OPS/12e74f5e).
 *
 * FIX A: the nightly wrapper wrote /tmp/vl2-out.json (+ vl2-err.txt) with NO
 * per-run suffix, so two overlapping vault-lint runs (manual + ~23:00 nightly)
 * clobbered each other's temp. Fix: mktemp unique paths + cleanup trap.
 *
 * FIX B: the daily-log entry (deterministic, data-driven from proposals.json)
 * lived in the scheduled-task PROMPT and ran in applegate's heartbeat session,
 * so it silently skipped whenever the heartbeat was not processed
 * (sleep/wedge/token). Remediation (shared-lesson scheduled-task-agent-dependency):
 * move the deterministic daily-log emit INTO the shell script so it is guaranteed
 * regardless of heartbeat; leave only the agent-interactive narrative in the prompt.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT_PATH = join(__dirname, '../../scripts/vault-lint-nightly-full.sh')

describe('vault-lint-nightly-full.sh — static assertions (FIX A + wiring)', () => {
  let src: string
  beforeAll(() => { src = readFileSync(SCRIPT_PATH, 'utf8') })

  it('does NOT hardcode the collision-prone /tmp/vl2-out.json redirect (FIX A)', () => {
    expect(src).not.toMatch(/>\s*\/tmp\/vl2-out\.json/)
    expect(src).not.toMatch(/2>\s*\/tmp\/vl2-err\.txt/)
  })

  it('uses mktemp for unique per-run temp files (FIX A)', () => {
    expect(src).toMatch(/mktemp/)
  })

  it('cleans up its temp files via an EXIT trap (FIX A)', () => {
    expect(src).toMatch(/trap\s+.*rm[^\n]*EXIT/)
  })

  it('makes MARVEEN_DIR overridable for testability', () => {
    expect(src).toMatch(/MARVEEN_DIR="\$\{MARVEEN_DIR:-/)
  })

  it('emits the deterministic daily-log entry from the shell (FIX B)', () => {
    expect(src).toMatch(/\/api\/daily-log/)
  })
})

describe('vault-lint-nightly-full.sh — functional run (FIX A + FIX B)', () => {
  let sandbox: string
  let curlCapture: string
  let tmpDir: string

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'vlnh-'))
    mkdirSync(join(sandbox, 'scripts'), { recursive: true })
    mkdirSync(join(sandbox, 'store'), { recursive: true })
    mkdirSync(join(sandbox, 'bin'), { recursive: true })
    tmpDir = join(sandbox, 'runtmp')
    mkdirSync(tmpDir, { recursive: true })

    // Fixture proposals.json mirroring the real shape (counts + rule/jaccard breakdown).
    const proposals = {
      timestamp: 1790888403,
      verdict: 'PROPOSALS',
      tier_migration_proposals: [
        { rule: 'TM-1', from_category: 'hot', to_category: 'warm', id: 1 },
        { rule: 'TM-2', from_category: 'hot', to_category: 'cold', id: 2 },
        { rule: 'TM-2', from_category: 'warm', to_category: 'cold', id: 3 },
      ],
      dedup_candidates: [
        { jaccard: 0.91, entry_a: 10, entry_b: 11 },
        { jaccard: 0.88, entry_a: 12, entry_b: 13 },
        { jaccard: 0.77, entry_a: 14, entry_b: 15 },
      ],
      counts: { tier_migration: 3, dedup_candidates: 95 },
    }
    writeFileSync(join(sandbox, 'store', 'vault-lint-l2-proposals.json'), JSON.stringify(proposals))
    writeFileSync(join(sandbox, 'store', '.dashboard-token'), 'test-token-xyz\n')

    // Stub the two python scripts the wrapper invokes (layer2 generator + TM-1 executor).
    // layer2 is a no-op: proposals.json already exists so the wrapper's existence check passes.
    writeFileSync(join(sandbox, 'scripts', 'vault-lint-layer2.py'), 'import sys\nsys.exit(0)\n')
    writeFileSync(join(sandbox, 'scripts', 'vault-lint-tm1-executor.py'), 'import sys\nsys.exit(0)\n')

    // curl shim: capture full argv (one call per line) so we can assert the POST payload.
    curlCapture = join(sandbox, 'curl-capture.txt')
    const curlShim = `#!/bin/bash\nprintf '%s\\0' "$@" >> ${JSON.stringify(curlCapture)}\nprintf '\\n' >> ${JSON.stringify(curlCapture)}\necho '{"ok":true}'\n`
    const curlPath = join(sandbox, 'bin', 'curl')
    writeFileSync(curlPath, curlShim)
    chmodSync(curlPath, 0o755)

    execFileSync('bash', [SCRIPT_PATH], {
      env: {
        ...process.env,
        MARVEEN_DIR: sandbox,
        TMPDIR: tmpDir,
        DASH_URL: 'http://localhost:3420',
        PATH: `${join(sandbox, 'bin')}:${process.env.PATH}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })

  it('posts a deterministic daily-log entry with the proposal counts (FIX B)', () => {
    const cap = readFileSync(curlCapture, 'utf8')
    expect(cap).toMatch(/\/api\/daily-log/)
    // the POST body must carry the data-driven counts parsed from proposals.json
    expect(cap).toMatch(/TM=3/)
    expect(cap).toMatch(/dedup=95/)
  })

  it('authenticates the daily-log POST with the dashboard Bearer token (FIX B)', () => {
    const cap = readFileSync(curlCapture, 'utf8')
    expect(cap).toMatch(/Bearer test-token-xyz/)
  })

  it('leaves NO leftover temp files (EXIT trap cleaned up) (FIX A)', () => {
    const leftovers = existsSync(tmpDir) ? readdirSync(tmpDir).filter(f => /vl2-(out|err)/.test(f)) : []
    expect(leftovers).toEqual([])
  })
})
