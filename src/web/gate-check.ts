// Mechanical merge-gate enforcement -- pure decision logic (no IO).
//
// The fleet's three-sided merge gate (Thor QA + Dave eng + Chad security) was a
// social convention: any agent holding the shared PAT could call the GitHub
// merge API before all reviewers signed off. PR #206 was the proof-of-exploit
// (Chad PASS present, Dave absent, merge succeeded, revert required). This
// module is the brain of the mechanical replacement: given the approval rows for
// a PR's CURRENT head.sha plus the security-sensitivity of the diff, it computes
// whether the merge may proceed. All functions here are pure and side-effect
// free so the load-bearing invariants are exhaustively unit-testable.
//
// See store/specs/merge-gate-enforcement.md (card fa11eb63).

export const GATE_REVIEWERS = ['thor', 'dave', 'chad'] as const
export type Reviewer = (typeof GATE_REVIEWERS)[number]

export const GATE_VERDICTS = ['approved', 'blocked'] as const
export type Verdict = (typeof GATE_VERDICTS)[number]

const SHA_RE = /^[0-9a-f]{40}$/

export function isValidSha(sha: unknown): sha is string {
  return typeof sha === 'string' && SHA_RE.test(sha)
}

export function isValidReviewer(r: unknown): r is Reviewer {
  return typeof r === 'string' && (GATE_REVIEWERS as readonly string[]).includes(r)
}

export function isValidVerdict(v: unknown): v is Verdict {
  return typeof v === 'string' && (GATE_VERDICTS as readonly string[]).includes(v)
}

export function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0
}

// MG-AC4 -- security-PR detection. A PR requires Chad's approval if its diff
// touches any security-sensitive path. The patterns are matched against the
// GitHub `filename` field (a repo-relative POSIX path). Conservative by design:
// a false positive only adds a (harmless) Chad requirement, a false negative
// would let a credential/guardrail change skip security review (the #206 class).
export function isSecuritySensitivePath(filename: string): boolean {
  if (typeof filename !== 'string' || filename.length === 0) return false
  const f = filename.toLowerCase()

  // Directory-rooted patterns: scripts/hooks/** and src/mcp/**.
  if (f.startsWith('scripts/hooks/')) return true
  if (f.startsWith('src/mcp/')) return true

  // Exact-file patterns.
  if (f === 'src/aidefence-guard.ts') return true
  if (f === 'src/prompt-safety.ts') return true
  if (f === 'src/team-trust.ts') return true

  // Gate self-protection (card 88eb6120, Chad FLAG[medium]): the merge-gate's
  // OWN enforcement code and its operative skill must themselves require Chad,
  // otherwise a PR that weakens the gate could merge without security review --
  // the enforcer would not guard the enforcer (same blind-spot class as #206).
  if (f === 'src/web/gate-check.ts') return true
  if (f === 'src/web/gate-db.ts') return true
  if (f === 'src/web/github-pr.ts') return true
  if (f === 'src/web/github-merge.ts') return true  // card cfb10d14 (Thor MINOR PR#230)
  if (f === 'src/web/routes/gate.ts') return true
  if (f === 'src/web/routes/github.ts') return true  // card cfb10d14 (Thor MINOR PR#230)
  if (f.startsWith('seed-skills/fleet-pr-merge-gate/')) return true

  // Auth/credential modules not caught by keyword patterns (card 9839f503, Chad scope-bővítés):
  // their names don't contain token/oauth/credential in a qualifying path context yet they
  // carry credential-handling logic that must require Chad review.
  if (f === 'src/web/dashboard-auth.ts') return true          // rotateDashboardToken + rotateSessionSecret
  if (f === 'src/web/agent-identity-binding.ts') return true  // all auth-gate logic (decideMemoryMutation etc.)
  if (f === 'src/web/agent-token-registry.ts') return true    // per-agent token minting/resolution
  if (f === 'src/web/routes/admin.ts') return true            // credential-invalidation endpoints

  const base = f.split('/').pop() ?? f

  // **/.env* -- any dotenv file at any depth.
  if (base.includes('.env')) return true

  // **/guardrail*, **/oauth*, **/credential* -- keyword anywhere in the basename.
  if (base.includes('guardrail') || base.includes('oauth') || base.includes('credential')) return true

  // **/token* but only in an auth/secret/store context (Thor non-blocker #3:
  // qualified to avoid matching unrelated token-shaped names). The qualifier is
  // checked against the FULL path so e.g. store/token-expiry.ts qualifies.
  if (base.includes('token') && (f.includes('auth') || f.includes('secret') || f.includes('store'))) {
    return true
  }

  return false
}

// Required reviewers for a PR: Thor + Dave always; Chad added for a
// security-sensitive diff (MG-AC4).
export function requiredReviewers(securityTouched: boolean): Reviewer[] {
  return securityTouched ? ['thor', 'dave', 'chad'] : ['thor', 'dave']
}

export interface ApprovalRow {
  reviewer: string
  verdict: string
  recorded_at: number
}

export interface GateEvaluation {
  approved: string[] // distinct reviewers with an approved verdict and NO block
  blocked: string[] // distinct reviewers with any blocked verdict on this sha
  missing: string[] // required reviewers not present in `approved`
  pass: boolean
}

// Core gate evaluation over the approval rows for ONE (pr, head_sha) pair.
//
// Blocked-stickiness (spec "one definition, used everywhere", MG-SEC3): a
// `blocked` verdict for any reviewer is permanent for that sha -- a later
// `approved` row on the same (pr, sha, reviewer) does NOT clear it, so a blocked
// reviewer never appears in `approved`. Any blocked record at all fails the gate
// (fail-safe). The only way to clear a block is a new commit (new sha), which
// this function never sees because the caller queries by the current sha.
//
// Distinct-reviewer (MG-SEC6): reviewers are de-duplicated via sets, so three
// rows all claiming `reviewer=thor` satisfy only the thor role.
//
// Simultaneous approve+block for the same reviewer (edge-case table): blocked
// always wins regardless of INSERT order, because the block set is computed
// first and excludes that reviewer from `approved`.
export function evaluateApprovals(approvals: ApprovalRow[], required: Reviewer[]): GateEvaluation {
  const blockedSet = new Set<string>()
  for (const a of approvals) {
    if (a.verdict === 'blocked') blockedSet.add(a.reviewer)
  }
  const approvedSet = new Set<string>()
  for (const a of approvals) {
    if (a.verdict === 'approved' && !blockedSet.has(a.reviewer)) approvedSet.add(a.reviewer)
  }
  const blocked = [...blockedSet].sort()
  const approved = [...approvedSet].sort()
  const missing = required.filter((r) => !approvedSet.has(r))
  const pass = blocked.length === 0 && missing.length === 0
  return { approved, blocked, missing, pass }
}

export interface GithubPrInfo {
  headSha: string
  files: string[]
}

export interface GateCheckDeps {
  // Fetches the LIVE head.sha and changed-file list from GitHub. Injected so the
  // pure check orchestration is testable without network access.
  fetchPr: (pr: number) => Promise<GithubPrInfo>
  readApprovals: (pr: number, sha: string) => ApprovalRow[]
  hasActiveOverride: (pr: number, sha: string) => boolean
}

export interface GateCheckResult {
  pr_number: number
  head_sha: string
  required: string[]
  approved: string[]
  blocked: string[]
  missing: string[]
  pass: boolean
  override_active: boolean
}

// MG-AC3 / MG-AC6 -- the gate check. Always evaluates against the CURRENT
// head.sha fetched from GitHub, so approvals recorded against a stale sha (the
// PR was rebased / got a new commit) are simply not found and the gate fails
// with everything missing. A Boss-level override for the current (pr, sha)
// forces pass=true (MG-AC7) while still reporting the underlying approval state.
export async function runGateCheck(pr: number, deps: GateCheckDeps): Promise<GateCheckResult> {
  const { headSha, files } = await deps.fetchPr(pr)
  const securityTouched = files.some(isSecuritySensitivePath)
  const required = requiredReviewers(securityTouched)
  const evaluation = evaluateApprovals(deps.readApprovals(pr, headSha), required)
  const overrideActive = deps.hasActiveOverride(pr, headSha)
  return {
    pr_number: pr,
    head_sha: headSha,
    required,
    approved: evaluation.approved,
    blocked: evaluation.blocked,
    missing: evaluation.missing,
    pass: overrideActive ? true : evaluation.pass,
    override_active: overrideActive,
  }
}
