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

// ---------------------------------------------------------------------------
// Pre-gate independent CI (Buster-CI) -- card 0c166e48 (D-2/T-2 convergence).
//
// The gate trusts the author's own tsc+vitest output; a lying author or a
// falsely-green fixture slips through and Thor cannot re-run the suite. The fix
// is an INDEPENDENT run: Buster checks the PR head out clean, runs tsc+tests,
// and posts a (pr, head_sha)-scoped PASS/FAIL bundle. The gate, when enforcement
// is enabled, requires a fresh CI PASS in addition to the reviewer seats. The
// bundle is bound to the head.sha, so a rebased head loses its CI PASS exactly
// like it loses its approvals (same-head invariant, reused).
// ---------------------------------------------------------------------------

// The two statuses a CI runner may POST. `none` is DERIVED (no run for this sha)
// and is never a valid posted value.
export const CI_STATUSES = ['pass', 'fail'] as const
export type PostableCiStatus = (typeof CI_STATUSES)[number]
export type CiStatus = PostableCiStatus | 'none'

export function isValidCiStatus(s: unknown): s is PostableCiStatus {
  return typeof s === 'string' && (CI_STATUSES as readonly string[]).includes(s)
}

// Resolve the gate-relevant CI status from the LATEST run for a (pr, sha).
// latest-run-wins: a re-run (e.g. flaky infra) can flip a sha's status, but the
// same sha is the same code so a genuine failure re-runs to fail. Any status
// that is not an explicit `pass` is treated as fail (fail-safe); a missing run
// is `none`.
export function resolveCiStatus(latest: { status: string } | null | undefined): CiStatus {
  if (!latest) return 'none'
  return latest.status === 'pass' ? 'pass' : 'fail'
}

// Safe-rollout flag. Enforcement is OFF by default so shipping this code (and
// the PR that adds it) cannot self-lock before a Buster runner exists: with the
// flag off the CI status is reported for observability but does not affect pass.
// Flip to enforce = separate Boss-GO.
export function isGateCiRequired(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.GATE_CI_REQUIRED
  return v === '1' || v === 'true'
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

  // src/analytics/** (card 8de7e55a, PR#335 gap): the analytics module holds the
  // OAuth token store (tokens.ts) + scopes (scopes.ts) + the external egress
  // clients (youtube.ts / twitch.ts) that call third-party APIs with those
  // credentials. The keyword patterns below MISS them -- 'analytics' carries no
  // auth/secret/store substring, so tokens.ts fails the token-qualifier and
  // scopes.ts matches no keyword -- so PR#335 merged its OAuth code without an
  // auto-required Chad. The whole module is credential+egress territory, so a
  // conservative directory-rooted trigger is the right umbrella. NOTE: the
  // auth-gated read route src/web/routes/analytics.ts is deliberately NOT here
  // (pure aggregation, no credential handling -- it stays thor+dave).
  if (f.startsWith('src/analytics/')) return true

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

  // Codetree change-impact surface (card b8e014a4, Thor flag on PR#259/139b5434):
  // a git-revision arg-injection surface (leading-dash ref -> `--output=` arbitrary
  // file write). routes/codetree.ts carries the DIFF_REF_RE validation guard;
  // codetree-impact-io.ts is the execFileSync('git', argv) sink. Weakening EITHER
  // is a security change, so both must auto-require Chad (they carry no
  // token/oauth/credential keyword, so the patterns below miss them).
  if (f === 'src/web/routes/codetree.ts') return true         // DIFF_REF_RE / AGENT_RE validation guard
  if (f === 'src/web/codetree-impact-io.ts') return true      // execFileSync('git', argv) sink

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

// The standing backup seat promoted when a required reviewer recuses (card
// 46de122b). Chad is the fleet's technical/security second seat.
const RECUSAL_BACKUP: Reviewer = 'chad'

export interface RecusalResult {
  required: Reviewer[]
  recused: Reviewer[]
}

// Author recusal (card 46de122b, MG-SEC7). A PR's author cannot fill their own
// gate seat -- MG-SEC5 blocks self-approval -- so hard-requiring a reviewer who
// authored the PR deadlocks the merge (PR#417: required=[thor,dave], author=dave,
// dave-seat unfillable -> 403 forever). This recuses a reviewer-author and
// promotes the backup seat (chad), but ONLY when that preserves coverage:
//   - author must be a gate reviewer AND currently in `required` (else identity);
//   - NEVER recuse the backup itself: on a security PR chad IS the sole security
//     seat, and recusing it would let the PR pass with zero security review
//     (#206 class). Keep it required so the seat stays unfillable-by-author and
//     the gate blocks until an operator relay records a real approval;
//   - NEVER drop below 2 distinct required reviewers.
// The trusted author identity comes ONLY from the identity-bound gate_pr_authors
// record (readPrAuthor) -- never from the GitHub PR user, which is the shared bot
// for every agent. A null / non-reviewer author is the identity function, so the
// gate behaves exactly as before recusal existed (fail-safe, strictly additive).
export function applyAuthorRecusal(required: Reviewer[], author: string | null): RecusalResult {
  if (!isValidReviewer(author) || !required.includes(author)) {
    return { required, recused: [] }
  }
  // Never recuse the backup seat -- it has no further substitute, and on a
  // security PR it is the only security review. Leave it required so the gate
  // blocks until an operator relay fills it.
  if (author === RECUSAL_BACKUP) {
    return { required, recused: [] }
  }
  // author is thor or dave: drop them, ensure the backup is present. Preserve the
  // original relative order (thor, dave, chad) rather than sorting -- the set is a
  // display convention, not alphabetical.
  const next = required.filter((r) => r !== author)
  if (!next.includes(RECUSAL_BACKUP)) next.push(RECUSAL_BACKUP)
  // Defensive floor: never emit a sub-2 required set (cannot occur for the
  // thor/dave x {security,non-security} matrix, but never weaken below 2).
  if (new Set(next).size < 2) {
    return { required, recused: [] }
  }
  return { required: next, recused: [author] }
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
  // Independent Buster-CI status for the CURRENT (pr, sha). Optional so existing
  // callers keep their exact behaviour: omitted -> `none`, never enforced.
  ciStatus?: (pr: number, sha: string) => CiStatus
  // Whether a CI PASS is required for the gate to pass (env GATE_CI_REQUIRED).
  // Default false -> observability only.
  ciRequired?: boolean
  // Trusted PR author from the identity-bound gate_pr_authors record (card
  // 46de122b). Optional so existing callers are unchanged: omitted -> null author
  // -> no recusal (fail-safe identity behavior).
  readAuthor?: (pr: number) => string | null
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
  // Independent-CI surface (card 0c166e48). ci_status is always reported;
  // ci_required reflects the rollout flag; ci_pass is the derived gate input.
  ci_status: CiStatus
  ci_required: boolean
  ci_pass: boolean
  // Author-recusal surface (card 46de122b). `author` is the trusted recorded
  // author (null when unknown -> no recusal, diagnosable rather than silent);
  // `recused` lists reviewers dropped from `required` because they authored the PR.
  author: string | null
  recused: string[]
}

// MG-AC3 / MG-AC6 -- the gate check. Always evaluates against the CURRENT
// head.sha fetched from GitHub, so approvals recorded against a stale sha (the
// PR was rebased / got a new commit) are simply not found and the gate fails
// with everything missing. A Boss-level override for the current (pr, sha)
// forces pass=true (MG-AC7) while still reporting the underlying approval state.
export async function runGateCheck(pr: number, deps: GateCheckDeps): Promise<GateCheckResult> {
  const { headSha, files } = await deps.fetchPr(pr)
  const securityTouched = files.some(isSecuritySensitivePath)
  // Author recusal (card 46de122b): a reviewer who authored the PR cannot fill
  // their own seat, so drop them from `required` and promote the backup. Author
  // comes from the trusted identity-bound record; null (or no dep) -> no recusal.
  const author = deps.readAuthor ? deps.readAuthor(pr) : null
  const recusal = applyAuthorRecusal(requiredReviewers(securityTouched), author)
  const required = recusal.required
  const evaluation = evaluateApprovals(deps.readApprovals(pr, headSha), required)
  const overrideActive = deps.hasActiveOverride(pr, headSha)

  // Independent Buster-CI (card 0c166e48). ci_status is bound to the live head
  // (same-head invariant): a stale bundle for an old sha is simply not found.
  // When enforcement is on, a fresh CI PASS is required IN ADDITION to the
  // reviewer seats; CI can never substitute for a missing seat. A Boss override
  // forces pass regardless (emergency path), same as for the reviewer gate.
  const ciStatus = deps.ciStatus ? deps.ciStatus(pr, headSha) : 'none'
  const ciPass = ciStatus === 'pass'
  const ciRequired = deps.ciRequired ?? false
  const ciSatisfied = !ciRequired || ciPass

  return {
    pr_number: pr,
    head_sha: headSha,
    required,
    approved: evaluation.approved,
    blocked: evaluation.blocked,
    missing: evaluation.missing,
    pass: overrideActive ? true : evaluation.pass && ciSatisfied,
    override_active: overrideActive,
    ci_status: ciStatus,
    ci_required: ciRequired,
    ci_pass: ciPass,
    author: author ?? null,
    recused: recusal.recused,
  }
}
