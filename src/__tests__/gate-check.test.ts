import { describe, it, expect } from 'vitest'
import {
  isValidSha,
  isValidReviewer,
  isValidVerdict,
  isPositiveInt,
  isSecuritySensitivePath,
  requiredReviewers,
  evaluateApprovals,
  runGateCheck,
  type ApprovalRow,
  type GateCheckDeps,
} from '../web/gate-check.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

describe('input validation (MG-AC1)', () => {
  it('isValidSha requires exactly 40 hex chars', () => {
    expect(isValidSha(SHA_A)).toBe(true)
    expect(isValidSha('abc123')).toBe(false) // 12-char truncation rejected
    expect(isValidSha('A'.repeat(40))).toBe(false) // uppercase is not [0-9a-f]
    expect(isValidSha('g'.repeat(40))).toBe(false) // non-hex
    expect(isValidSha(123)).toBe(false)
    expect(isValidSha(undefined)).toBe(false)
  })

  it('isValidReviewer accepts only thor/dave/chad', () => {
    expect(isValidReviewer('thor')).toBe(true)
    expect(isValidReviewer('dave')).toBe(true)
    expect(isValidReviewer('chad')).toBe(true)
    expect(isValidReviewer('alice')).toBe(false)
    expect(isValidReviewer('')).toBe(false)
  })

  it('isValidVerdict accepts only approved/blocked', () => {
    expect(isValidVerdict('approved')).toBe(true)
    expect(isValidVerdict('blocked')).toBe(true)
    expect(isValidVerdict('rejected')).toBe(false)
  })

  it('isPositiveInt rejects zero, negatives, and non-integers', () => {
    expect(isPositiveInt(207)).toBe(true)
    expect(isPositiveInt(0)).toBe(false)
    expect(isPositiveInt(-1)).toBe(false)
    expect(isPositiveInt(1.5)).toBe(false)
    expect(isPositiveInt('5')).toBe(false)
  })
})

describe('isSecuritySensitivePath (MG-AC4)', () => {
  it('matches scripts/hooks/** and src/mcp/**', () => {
    expect(isSecuritySensitivePath('scripts/hooks/guardrail-ask-first.py')).toBe(true)
    expect(isSecuritySensitivePath('scripts/hooks/guardrail-permission-rules.py')).toBe(true)
    expect(isSecuritySensitivePath('src/mcp/server.ts')).toBe(true)
  })

  it('matches the exact safety files', () => {
    expect(isSecuritySensitivePath('src/aidefence-guard.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/prompt-safety.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/team-trust.ts')).toBe(true)
  })

  it('matches dotenv, guardrail, oauth, credential anywhere', () => {
    expect(isSecuritySensitivePath('agents/claudia/.env')).toBe(true)
    expect(isSecuritySensitivePath('agents/claudia/.env.local')).toBe(true)
    expect(isSecuritySensitivePath('src/web/oauth-helper.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/credential-core.ts')).toBe(true)
    expect(isSecuritySensitivePath('scripts/guardrail-check.sh')).toBe(true)
  })

  it('matches token* only in auth/secret/store context (Thor non-blocker #3)', () => {
    expect(isSecuritySensitivePath('store/token-expiry.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/auth/token-refresh.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/secret/token.ts')).toBe(true)
    // token-shaped name with no auth/secret/store context -> NOT security
    expect(isSecuritySensitivePath('src/web/tokenizer.ts')).toBe(false)
  })

  it('does not match ordinary source files', () => {
    expect(isSecuritySensitivePath('src/db.ts')).toBe(false)
    expect(isSecuritySensitivePath('src/web/kanban.ts')).toBe(false)
    expect(isSecuritySensitivePath('')).toBe(false)
  })

  // Gate self-protection (card 88eb6120, Chad FLAG[medium]): the enforcer must
  // guard the enforcer. A PR that touches the gate's own code or its operative
  // skill must require Chad, else a future gate-weakening change would bypass
  // security review -- the same blind spot class as #206.
  it('matches the gate enforcement modules and skill (card 88eb6120)', () => {
    expect(isSecuritySensitivePath('src/web/gate-check.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/web/gate-db.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/web/github-pr.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/web/routes/gate.ts')).toBe(true)
    expect(isSecuritySensitivePath('seed-skills/fleet-pr-merge-gate/SKILL.md')).toBe(true)
  })

  // Codetree change-impact arg-injection surface (card b8e014a4, Thor flag on
  // PR#259/139b5434). Adversarial fixtures: the guard + the git-exec sink must
  // be caught (false-negative guard); the pure impact-logic module that carries
  // neither must NOT be caught (false-positive guard).
  it('matches the codetree git-ref guard and exec sink (card b8e014a4)', () => {
    expect(isSecuritySensitivePath('src/web/routes/codetree.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/web/codetree-impact-io.ts')).toBe(true)
  })

  it('does NOT match the pure codetree impact logic (no guard, no exec)', () => {
    // codetree-impact.ts builds the report from injected deps -- no DIFF_REF_RE,
    // no execFileSync -- so it stays 2-way; over-broadening would dilute the gate.
    expect(isSecuritySensitivePath('src/web/codetree-impact.ts')).toBe(false)
    expect(isSecuritySensitivePath('src/web/routes/kanban.ts')).toBe(false)
  })

  // GitHub endpoint modules carry PAT egress + gate enforcement -- a PR touching
  // them must require Chad review (card cfb10d14, Thor MINOR from PR#230).
  it('matches github-merge.ts and routes/github.ts (card cfb10d14)', () => {
    expect(isSecuritySensitivePath('src/web/github-merge.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/web/routes/github.ts')).toBe(true)
  })

  // Auth/credential modules not caught by keyword patterns (card 9839f503, Chad scope-bővítés).
  // dashboard-auth.ts: rotateDashboardToken + rotateSessionSecret (no 'token/auth' in path).
  // agent-identity-binding.ts: all auth-gate logic (decideMemoryMutation, enforceFromBinding...).
  // agent-token-registry.ts: per-agent token minting -- 'token' in name but not in auth/secret/store path.
  // routes/admin.ts: credential-invalidation endpoint (rotate token + kick sessions).
  it('matches auth/admin modules missing from keyword patterns (card 9839f503)', () => {
    expect(isSecuritySensitivePath('src/web/dashboard-auth.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/web/agent-identity-binding.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/web/agent-token-registry.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/web/routes/admin.ts')).toBe(true)
  })
})

describe('runGateCheck requires chad for a gate-code PR (card 88eb6120)', () => {
  it('a PR touching gate-check.ts pulls chad into the required set', async () => {
    const result = await runGateCheck(601, {
      fetchPr: async () => ({ headSha: 'a'.repeat(40), files: ['src/web/gate-check.ts'] }),
      readApprovals: () => [],
      hasActiveOverride: () => false,
    })
    expect(result.required).toEqual(['thor', 'dave', 'chad'])
    expect(result.missing).toContain('chad')
    expect(result.pass).toBe(false)
  })

  it('a PR touching routes/codetree.ts pulls chad into the required set (card b8e014a4)', async () => {
    const result = await runGateCheck(602, {
      fetchPr: async () => ({ headSha: 'b'.repeat(40), files: ['src/web/routes/codetree.ts'] }),
      readApprovals: () => [],
      hasActiveOverride: () => false,
    })
    expect(result.required).toEqual(['thor', 'dave', 'chad'])
    expect(result.missing).toContain('chad')
    expect(result.pass).toBe(false)
  })
})

describe('requiredReviewers (MG-AC4)', () => {
  it('is thor+dave for a non-security PR', () => {
    expect(requiredReviewers(false)).toEqual(['thor', 'dave'])
  })
  it('adds chad for a security PR', () => {
    expect(requiredReviewers(true)).toEqual(['thor', 'dave', 'chad'])
  })
})

function approval(reviewer: string, verdict: string, recorded_at = 1): ApprovalRow {
  return { reviewer, verdict, recorded_at }
}

describe('evaluateApprovals (MG-AC3, MG-SEC3, MG-SEC6)', () => {
  it('passes when all required reviewers approved and none blocked', () => {
    const r = evaluateApprovals([approval('thor', 'approved'), approval('dave', 'approved')], ['thor', 'dave'])
    expect(r.pass).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.blocked).toEqual([])
  })

  it('fails with the missing list when a required reviewer is absent', () => {
    const r = evaluateApprovals([approval('thor', 'approved')], ['thor', 'dave'])
    expect(r.pass).toBe(false)
    expect(r.missing).toEqual(['dave'])
  })

  it('blocked is sticky: a later approved on the same reviewer does NOT clear it', () => {
    const r = evaluateApprovals(
      [approval('dave', 'approved', 1), approval('dave', 'blocked', 2), approval('dave', 'approved', 3)],
      ['thor', 'dave'],
    )
    expect(r.blocked).toEqual(['dave'])
    expect(r.approved).not.toContain('dave')
    expect(r.pass).toBe(false)
  })

  it('blocked always wins regardless of INSERT order (simultaneous approve+block)', () => {
    const blockFirst = evaluateApprovals(
      [approval('thor', 'blocked', 1), approval('thor', 'approved', 2)],
      ['thor', 'dave'],
    )
    const approveFirst = evaluateApprovals(
      [approval('thor', 'approved', 1), approval('thor', 'blocked', 2)],
      ['thor', 'dave'],
    )
    expect(blockFirst.blocked).toEqual(['thor'])
    expect(approveFirst.blocked).toEqual(['thor'])
    expect(blockFirst.pass).toBe(false)
    expect(approveFirst.pass).toBe(false)
  })

  it('distinct reviewers: three thor approvals do not satisfy a three-sided gate (MG-SEC6)', () => {
    const r = evaluateApprovals(
      [approval('thor', 'approved', 1), approval('thor', 'approved', 2), approval('thor', 'approved', 3)],
      ['thor', 'dave', 'chad'],
    )
    expect(r.approved).toEqual(['thor'])
    expect(r.missing).toEqual(['dave', 'chad'])
    expect(r.pass).toBe(false)
  })

  it('extra approvals from a non-required reviewer are harmless (edge case)', () => {
    const r = evaluateApprovals(
      [approval('thor', 'approved'), approval('dave', 'approved'), approval('chad', 'approved')],
      ['thor', 'dave'],
    )
    expect(r.pass).toBe(true)
  })
})

// Stub GitHub fetch + DB reads so runGateCheck is exercised without network/db.
function deps(over: Partial<GateCheckDeps> & { headSha?: string; files?: string[]; approvals?: ApprovalRow[]; override?: boolean }): GateCheckDeps {
  return {
    fetchPr: async () => ({ headSha: over.headSha ?? SHA_A, files: over.files ?? [] }),
    readApprovals: over.readApprovals ?? (() => over.approvals ?? []),
    hasActiveOverride: over.hasActiveOverride ?? (() => over.override ?? false),
  }
}

describe('runGateCheck (MG-AC3, MG-AC6 staleness, MG-AC7 override)', () => {
  it('passes a non-security PR with thor+dave approved on the live sha', async () => {
    const r = await runGateCheck(207, deps({ files: ['src/db.ts'], approvals: [approval('thor', 'approved'), approval('dave', 'approved')] }))
    expect(r.required).toEqual(['thor', 'dave'])
    expect(r.pass).toBe(true)
    expect(r.head_sha).toBe(SHA_A)
  })

  it('requires chad for a security PR', async () => {
    const r = await runGateCheck(207, deps({ files: ['scripts/hooks/guardrail-x.py'], approvals: [approval('thor', 'approved'), approval('dave', 'approved')] }))
    expect(r.required).toEqual(['thor', 'dave', 'chad'])
    expect(r.missing).toEqual(['chad'])
    expect(r.pass).toBe(false)
  })

  it('stale approvals on an old sha do not count for the new sha (MG-AC6)', async () => {
    // Approvals exist for SHA_A, but the live head is SHA_B -> readApprovals(SHA_B) returns nothing.
    const readApprovals = (_pr: number, sha: string): ApprovalRow[] =>
      sha === SHA_A ? [approval('thor', 'approved'), approval('dave', 'approved')] : []
    const r = await runGateCheck(207, deps({ headSha: SHA_B, files: ['src/db.ts'], readApprovals }))
    expect(r.head_sha).toBe(SHA_B)
    expect(r.missing).toEqual(['thor', 'dave'])
    expect(r.pass).toBe(false)
  })

  it('an active override forces pass=true while still reporting missing (MG-AC7)', async () => {
    const r = await runGateCheck(207, deps({ files: ['src/db.ts'], approvals: [], override: true }))
    expect(r.override_active).toBe(true)
    expect(r.pass).toBe(true)
    expect(r.missing).toEqual(['thor', 'dave']) // transparency: still reported
  })
})
