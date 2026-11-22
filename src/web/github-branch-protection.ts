// Server-side branch protection enforcer (card e0afd7e9, SEC T1 mitigation).
//
// POST /api/github/branch-protection -> PUT /repos/Bigi-HS/marveen/branches/{branch}/protection
//
// SECURITY CONTRACT:
//   - Fail-closed: ONLY the two hardcoded branches (main, develop) are accepted.
//     This is NOT a general branch-protection-writer; it enforces a fixed baseline
//     (force_pushes=false, deletions=false) on the two protected refs only.
//   - The fleet PAT is read in-process, placed only in Authorization header,
//     never returned or logged.
//   - Auth/permission errors from GitHub are masked as 502 (credential probing
//     prevention, same policy as github-pr.ts).
//   - Boss-GO required for any expansion of PROTECTED_BRANCHES.

import { readGithubToken } from './github-pr.js'
import type { GithubDeps } from './github-pr.js'

const GATE_REPO = process.env['GATE_REPO'] ?? 'Bigi-HS/marveen'

// The only two branches this route may protect. Hardcoded -- not configurable
// at runtime. Any extension requires a Boss-GO + new PR + Chad SEC gate.
export const PROTECTED_BRANCHES: readonly string[] = ['main', 'develop']

export class BranchProtectionError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'BranchProtectionError'
  }
}

export type BranchValidation =
  | { ok: true; branch: string }
  | { ok: false; error: string }

// Pure input validation -- no network. Rejects any branch not in the allowlist.
export function validateBranchProtectionParams(p: Record<string, unknown>): BranchValidation {
  const raw = typeof p['branch'] === 'string' ? p['branch'].trim() : null
  if (!raw) return { ok: false, error: 'branch is required' }
  if (!PROTECTED_BRANCHES.includes(raw)) {
    return {
      ok: false,
      error: `branch must be one of the protected allowlist: ${PROTECTED_BRANCHES.join(', ')}`,
    }
  }
  return { ok: true, branch: raw }
}

export interface BranchProtectionResult {
  branch: string
  applied: boolean
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'marveen-branch-protection',
  }
}

async function safeGithubMessage(res: { json: () => Promise<unknown> }, status: number): Promise<string> {
  try {
    const j = await res.json()
    const m = typeof (j as Record<string, unknown>)?.['message'] === 'string'
      ? (j as Record<string, unknown>)['message'] as string
      : ''
    if (m) return m.slice(0, 300)
  } catch { /* fall through */ }
  return `GitHub error (${status})`
}

// Apply the security baseline to a single branch. Validates first, then makes
// exactly ONE external call (PUT /repos/<GATE_REPO>/branches/<branch>/protection).
// Dependency-injected so unit tests avoid real network calls.
export async function setBranchProtection(
  branch: string,
  deps: GithubDeps = {},
): Promise<BranchProtectionResult> {
  const v = validateBranchProtectionParams({ branch })
  if (!v.ok) throw new BranchProtectionError(400, v.error)

  const doFetch = deps.fetchImpl ?? fetch
  const token = (deps.readToken ?? readGithubToken)()

  // GitHub branch protection payload. We set only what we need:
  //   - allow_force_pushes: false  (T1: prevent force-push to protected branches)
  //   - allow_deletions: false     (T1: prevent branch deletion)
  // required_status_checks: null means "do not change required CI checks" --
  // the GitHub API requires the field to be present but null is a valid value
  // when no CI policy is being set. required_pull_request_reviews: null likewise.
  // enforce_admins: false avoids blocking the fleet operator (Boss) from an
  // emergency direct push while still protecting automated agents.
  const body = {
    required_status_checks: null,
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  }

  let res: { ok: boolean; status: number; json: () => Promise<unknown> }
  try {
    res = await doFetch(
      `https://api.github.com/repos/${GATE_REPO}/branches/${v.branch}/protection`,
      {
        method: 'PUT',
        headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
  } catch {
    throw new BranchProtectionError(502, 'GitHub request failed')
  }

  if (res.ok) {
    return { branch: v.branch, applied: true }
  }

  if (res.status === 401 || res.status === 403) {
    throw new BranchProtectionError(502, 'GitHub authentication/permission error')
  }
  throw new BranchProtectionError(res.status, await safeGithubMessage(res, res.status))
}
