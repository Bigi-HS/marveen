/**
 * Pre-gate independent CI (Buster-CI) integration into the merge gate --
 * pure decision logic (card 0c166e48, D-2/T-2 convergence).
 *
 * The gate today trusts the AUTHOR's tsc+vitest output; a lying author or a
 * falsely-green fixture (the PR#335 env-local worktree case) slips through, and
 * Thor cannot run the suite independently. The fix is an independent Buster
 * sandbox CI run, posted as a (pr, head_sha)-scoped bundle, that the gate
 * requires (when enforcement is on) in addition to the reviewer seats.
 *
 * These tests pin the PURE half: how a CI status resolves from the latest run,
 * and how runGateCheck folds ci_pass into the overall pass -- reusing the
 * same-head invariant (a CI bundle is bound to a sha, exactly like an approval).
 * The enforcement is behind ciRequired so the default (flag off) is pure
 * observability and backward-compatible with every existing caller.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveCiStatus,
  isValidCiStatus,
  isGateCiRequired,
  runGateCheck,
  type ApprovalRow,
  type GateCheckDeps,
  type CiStatus,
} from '../web/gate-check.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

const approval = (reviewer: string, verdict: string): ApprovalRow => ({
  reviewer,
  verdict,
  recorded_at: 1000,
})

// Stub the network + DB reads so runGateCheck runs pure. ciStatus/ciRequired are
// optional -- omitting them must reproduce the pre-CI behaviour exactly.
function deps(
  over: Partial<GateCheckDeps> & {
    headSha?: string
    files?: string[]
    approvals?: ApprovalRow[]
    override?: boolean
    ci?: CiStatus
    ciRequired?: boolean
  },
): GateCheckDeps {
  return {
    fetchPr: async () => ({ headSha: over.headSha ?? SHA_A, files: over.files ?? [] }),
    readApprovals: over.readApprovals ?? (() => over.approvals ?? []),
    hasActiveOverride: over.hasActiveOverride ?? (() => over.override ?? false),
    ciStatus: over.ciStatus ?? (over.ci !== undefined ? () => over.ci! : undefined),
    ciRequired: over.ciRequired,
  }
}

describe('resolveCiStatus (latest-run-wins over one sha)', () => {
  it('no run -> none', () => {
    expect(resolveCiStatus(null)).toBe('none')
    expect(resolveCiStatus(undefined)).toBe('none')
  })
  it('a passing latest run -> pass', () => {
    expect(resolveCiStatus({ status: 'pass' })).toBe('pass')
  })
  it('a failing latest run -> fail', () => {
    expect(resolveCiStatus({ status: 'fail' })).toBe('fail')
  })
  it('an unrecognised status is treated as fail (fail-safe)', () => {
    expect(resolveCiStatus({ status: 'weird' })).toBe('fail')
  })
})

describe('isValidCiStatus', () => {
  it('accepts only pass/fail (the postable statuses)', () => {
    expect(isValidCiStatus('pass')).toBe(true)
    expect(isValidCiStatus('fail')).toBe(true)
    expect(isValidCiStatus('none')).toBe(false) // "none" is derived, never posted
    expect(isValidCiStatus('')).toBe(false)
    expect(isValidCiStatus(123)).toBe(false)
  })
})

describe('isGateCiRequired (env flag, default OFF for safe rollout)', () => {
  it('defaults to false when unset', () => {
    expect(isGateCiRequired({})).toBe(false)
  })
  it('true only for an explicit 1/true', () => {
    expect(isGateCiRequired({ GATE_CI_REQUIRED: '1' })).toBe(true)
    expect(isGateCiRequired({ GATE_CI_REQUIRED: 'true' })).toBe(true)
    expect(isGateCiRequired({ GATE_CI_REQUIRED: '0' })).toBe(false)
    expect(isGateCiRequired({ GATE_CI_REQUIRED: 'no' })).toBe(false)
  })
})

describe('runGateCheck folds CI into the gate (card 0c166e48)', () => {
  const approved = [approval('thor', 'approved'), approval('dave', 'approved')]

  it('backward-compat: no ci deps -> ci_status none, ci_required false, pass unchanged', async () => {
    const r = await runGateCheck(700, deps({ files: ['src/db.ts'], approvals: approved }))
    expect(r.pass).toBe(true)
    expect(r.ci_status).toBe('none')
    expect(r.ci_required).toBe(false)
    expect(r.ci_pass).toBe(false)
  })

  it('flag OFF: reviewers pass, CI missing -> still pass (observability only)', async () => {
    const r = await runGateCheck(700, deps({ files: ['src/db.ts'], approvals: approved, ci: 'none', ciRequired: false }))
    expect(r.pass).toBe(true)
    expect(r.ci_status).toBe('none')
    expect(r.ci_required).toBe(false)
  })

  it('flag ON: reviewers pass + CI pass -> pass', async () => {
    const r = await runGateCheck(700, deps({ files: ['src/db.ts'], approvals: approved, ci: 'pass', ciRequired: true }))
    expect(r.pass).toBe(true)
    expect(r.ci_status).toBe('pass')
    expect(r.ci_pass).toBe(true)
    expect(r.ci_required).toBe(true)
  })

  it('flag ON: reviewers pass but CI missing -> BLOCKED (independent-verify gap closed)', async () => {
    const r = await runGateCheck(700, deps({ files: ['src/db.ts'], approvals: approved, ci: 'none', ciRequired: true }))
    expect(r.pass).toBe(false)
    expect(r.ci_status).toBe('none')
    expect(r.ci_pass).toBe(false)
    expect(r.missing).toEqual([]) // reviewers are all present; the block is CI, not a seat
  })

  it('flag ON: reviewers pass but CI failed -> blocked', async () => {
    const r = await runGateCheck(700, deps({ files: ['src/db.ts'], approvals: approved, ci: 'fail', ciRequired: true }))
    expect(r.pass).toBe(false)
    expect(r.ci_status).toBe('fail')
  })

  it('flag ON: CI pass but a reviewer missing -> still blocked (CI does not substitute a seat)', async () => {
    const r = await runGateCheck(700, deps({ files: ['src/db.ts'], approvals: [approval('thor', 'approved')], ci: 'pass', ciRequired: true }))
    expect(r.pass).toBe(false)
    expect(r.missing).toEqual(['dave'])
    expect(r.ci_pass).toBe(true)
  })

  it('flag ON: a Boss override forces pass even with CI missing (emergency path)', async () => {
    const r = await runGateCheck(700, deps({ files: ['src/db.ts'], approvals: [], override: true, ci: 'none', ciRequired: true }))
    expect(r.pass).toBe(true)
    expect(r.override_active).toBe(true)
    expect(r.ci_status).toBe('none')
  })
})
