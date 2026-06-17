import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

// Hardening guard for scripts/hooks/ack-declare.sh (Chad INFO#1, PR#211):
// AGENT_ID is interpolated into the declare URL, so the script must refuse any
// value outside the strict [a-z0-9_-]+ allowlist BEFORE it reaches curl.
const HOOK = join(PROJECT_ROOT, 'scripts/hooks/ack-declare.sh')

// Run the hook with a given argv, returning {code, stderr}. Never reaches the
// live dashboard: MARVEEN_DASHBOARD_URL points at a closed port so a value that
// passes the guard fails fast at the network layer instead of declaring for real.
function run(args: string[]): { code: number; stderr: string } {
  try {
    execFileSync('bash', [HOOK, ...args], {
      env: { ...process.env, MARVEEN_DASHBOARD_URL: 'http://127.0.0.1:1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 10_000,
    })
    return { code: 0, stderr: '' }
  } catch (err: any) {
    return { code: err.status ?? 1, stderr: (err.stderr ?? Buffer.from('')).toString() }
  }
}

describe('ack-declare.sh AGENT_ID validation', () => {
  it('rejects a missing AGENT_ID (non-zero exit)', () => {
    expect(run([]).code).not.toBe(0)
  })

  it('rejects a shell-metacharacter AGENT_ID before any network call', () => {
    const r = run(['dave;rm -rf /tmp/x'])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('invalid AGENT_ID')
  })

  it('rejects a command-substitution AGENT_ID', () => {
    const r = run(['foo$(whoami)'])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('invalid AGENT_ID')
  })

  it('rejects an uppercase / slash-bearing AGENT_ID', () => {
    expect(run(['Dave']).stderr).toContain('invalid AGENT_ID')
    expect(run(['a/b']).stderr).toContain('invalid AGENT_ID')
  })

  it('accepts a valid agent name (passes the guard; only the network layer fails)', () => {
    // Closed port -> curl fails (non-zero), but the guard must NOT have rejected it.
    expect(run(['dave']).stderr).not.toContain('invalid AGENT_ID')
    expect(run(['thor_2-x']).stderr).not.toContain('invalid AGENT_ID')
  })
})
