// Server-side GitHub merge endpoint (card be1f3711).
//
// POST /api/github/merge {pr_number, head_sha, merge_method?}
//
// Security guarantees (see gate.ts MG-SEC4 comment for context):
//   1. runGateCheck is enforced SERVER-SIDE before any merge call -- the
//      client cannot bypass the gate by calling the GitHub API directly
//      (external-curl guard) and cannot skip gate approval via this route.
//   2. 40-char head_sha guard: the caller must supply the exact 40-char SHA
//      they believe is the current head. This is matched against the LIVE
//      head.sha fetched by runGateCheck. A mismatch (PR rebased / new commit
//      since the caller checked) returns 409 -- forcing the caller to
//      re-verify before merging.
//   3. PAT stays server-side: never in any response, never logged.
//   4. Fixed GATE_REPO (same env var as github-pr.ts): not caller-controlled.
//   5. 401/403 from GitHub masked as 502 (prevents credential-probing).

import type { GithubDeps } from './github-pr.js'
import { readGithubToken } from './github-pr.js'

// Re-export so the route layer can inject a seam without touching github-pr.ts.
export type { GithubDeps }

const GATE_REPO = process.env['GATE_REPO'] ?? 'Bigi-HS/marveen'

export const MERGE_METHOD_ALLOWLIST = ['merge', 'squash', 'rebase'] as const
export type MergeMethod = (typeof MERGE_METHOD_ALLOWLIST)[number]

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface MergeParams {
  pr: number
  headSha: string
  mergeMethod?: MergeMethod
}

export interface MergeResult {
  merged: boolean
  sha: string
  message: string
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SHA_RE = /^[0-9a-fA-F]{40}$/

export type MergeValidation =
  | { ok: true; pr: number; headSha: string; mergeMethod: MergeMethod }
  | { ok: false; error: string }

export function validateMergeParams(p: Partial<MergeParams>): MergeValidation {
  const pr = p.pr
  if (typeof pr !== 'number' || !Number.isInteger(pr) || pr <= 0) {
    return { ok: false, error: 'pr_number must be a positive integer' }
  }

  const headSha = p.headSha ?? ''
  if (!SHA_RE.test(headSha)) {
    return { ok: false, error: 'head_sha must be exactly 40 hex characters' }
  }

  const method = p.mergeMethod ?? 'merge'
  if (!(MERGE_METHOD_ALLOWLIST as readonly string[]).includes(method)) {
    return {
      ok: false,
      error: `merge_method must be one of: ${MERGE_METHOD_ALLOWLIST.join(', ')}`,
    }
  }

  return { ok: true, pr, headSha, mergeMethod: method as MergeMethod }
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class MergeRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'MergeRequestError'
  }
}

// ---------------------------------------------------------------------------
// Core merge function (injectable for tests)
// ---------------------------------------------------------------------------

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'marveen-merge-gate',
  }
}

async function safeGithubMessage(res: { json: () => Promise<unknown> }, status: number): Promise<string> {
  try {
    const j = await res.json()
    const m = typeof (j as Record<string, unknown>)?.['message'] === 'string'
      ? (j as Record<string, string>)['message']
      : ''
    if (m) return m.slice(0, 300)
  } catch {
    /* ignore */
  }
  return `GitHub error (${status})`
}

/**
 * Merge a pull request on GATE_REPO. Validates params first, then makes
 * exactly ONE external call (PUT /repos/<GATE_REPO>/pulls/<pr>/merge).
 * The PAT is read in-process and placed only in the Authorization header.
 *
 * NOTE: Gate enforcement (runGateCheck + SHA comparison) is the CALLER's
 * responsibility. This function only performs the network merge. The route
 * handler in routes/github.ts runs the gate check before calling here.
 */
export async function mergePullRequest(
  params: MergeParams,
  deps: GithubDeps = {},
): Promise<MergeResult> {
  const v = validateMergeParams(params)
  if (!v.ok) throw new MergeRequestError(400, v.error)

  const doFetch = deps.fetchImpl ?? fetch
  const token = (deps.readToken ?? readGithubToken)()

  let res: { ok: boolean; status: number; json: () => Promise<unknown> }
  try {
    res = await doFetch(
      `https://api.github.com/repos/${GATE_REPO}/pulls/${v.pr}/merge`,
      {
        method: 'PUT',
        headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sha: v.headSha,
          merge_method: v.mergeMethod,
        }),
      },
    )
  } catch {
    throw new MergeRequestError(502, 'GitHub request failed')
  }

  if (res.ok) {
    let j: Record<string, unknown>
    try {
      j = (await res.json()) as Record<string, unknown>
    } catch {
      throw new MergeRequestError(502, 'GitHub merge response malformed')
    }
    const sha = typeof j['sha'] === 'string' ? j['sha'] : ''
    const message = typeof j['message'] === 'string' ? j['message'] : 'Merged'
    if (!sha) throw new MergeRequestError(502, 'GitHub merge response missing sha')
    return { merged: true, sha, message }
  }

  // Auth/permission failures: server-side credential problem, mask from caller.
  if (res.status === 401 || res.status === 403) {
    throw new MergeRequestError(502, 'GitHub authentication/permission error')
  }

  // 405 = PR not mergeable (already merged / draft / conflicts).
  // 409 = merge conflict. Both surface as 409 Conflict to the caller.
  if (res.status === 405 || res.status === 409) {
    const msg = await safeGithubMessage(res, res.status)
    throw new MergeRequestError(409, msg)
  }

  // Any other GitHub error.
  const msg = await safeGithubMessage(res, res.status)
  throw new MergeRequestError(res.status >= 500 ? 502 : res.status, msg)
}
