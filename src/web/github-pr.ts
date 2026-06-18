// Mechanical merge-gate enforcement -- GitHub PR reader.
//
// The gate check needs the LIVE head.sha and changed-file list of a PR. There is
// no `gh` CLI on this host; we call the REST API directly with the fleet PAT
// from ~/.git-credentials (mode 0600). The token is read in-process and never
// logged. Isolated here so the route layer can inject a stub in tests.
//
// See store/specs/merge-gate-enforcement.md (card fa11eb63).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GithubPrInfo } from './gate-check.js'

// PRs live on the fork that hosts the fleet repo. Overridable for tests / a
// future repo move, but never needs to be set in normal operation.
const GATE_REPO = process.env['GATE_REPO'] ?? 'Bigi-HS/marveen'
const FILES_PAGE_CAP = 10 // 10 * 100 = 1000 files; a real PR never approaches this.

export function readGithubToken(): string {
  const creds = readFileSync(join(homedir(), '.git-credentials'), 'utf-8')
  const m = creds.match(/https:\/\/[^:@/]+:([^@]+)@github\.com/)
  if (!m) throw new Error('no GitHub token found in ~/.git-credentials')
  return m[1]
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'marveen-merge-gate',
  }
}

// --- Server-side PR-open (card 5bfe0e1f) ---------------------------------
//
// The external-curl guard blocks agent Bash mutating curl to non-localhost, so
// agents can no longer open PRs by curling api.github.com directly. This opens
// the PR SERVER-SIDE with the fleet PAT: the agent hits a localhost dashboard
// route (allowed), and the only external egress is this ONE fixed call. It is
// deliberately NOT a generic GitHub proxy -- the repo is pinned to GATE_REPO and
// the sole operation is "create a pull request" -- so it restores the PR-flow
// without reopening an exfiltration channel.

// Base branches a server-opened PR may target. An allowlist (not a free string)
// so the endpoint can never be coaxed into targeting an arbitrary ref.
export const PR_BASE_ALLOWLIST: readonly string[] = ['develop', 'main']

// A git branch name we will accept as `head`: ref-name characters only. The
// absence of ':' forbids the GitHub "owner:branch" cross-fork form, locking the
// PR's head to a branch on GATE_REPO itself.
const HEAD_BRANCH_RE = /^[A-Za-z0-9._/-]+$/
const MAX_HEAD_LEN = 255
const MAX_TITLE_LEN = 256
const MAX_BODY_LEN = 65536

export interface OpenPrParams {
  head: string
  base?: string
  title: string
  body?: string
}

export interface OpenPrResult {
  number: number
  htmlUrl: string
  head: string
  base: string
}

export type PrValidation =
  | { ok: true; head: string; base: string; title: string; body: string }
  | { ok: false; error: string }

// An error that carries the HTTP status the route should return.
export class PrRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'PrRequestError'
  }
}

// Pure input validation -- no network, exhaustively unit-tested. The route and
// openPullRequest both gate on this so a bad request fails BEFORE any egress.
export function validatePrParams(p: Partial<OpenPrParams>): PrValidation {
  const head = typeof p.head === 'string' ? p.head.trim() : ''
  if (!head) return { ok: false, error: 'head branch is required' }
  if (head.length > MAX_HEAD_LEN) return { ok: false, error: 'head branch too long' }
  if (head.includes('..') || !HEAD_BRANCH_RE.test(head)) {
    return { ok: false, error: 'head branch has invalid characters (a plain branch name on this repo is required)' }
  }
  const base = typeof p.base === 'string' && p.base.trim() ? p.base.trim() : 'develop'
  if (!PR_BASE_ALLOWLIST.includes(base)) {
    return { ok: false, error: `base must be one of: ${PR_BASE_ALLOWLIST.join(', ')}` }
  }
  const title = typeof p.title === 'string' ? p.title.trim() : ''
  if (!title) return { ok: false, error: 'title is required' }
  if (title.length > MAX_TITLE_LEN) return { ok: false, error: 'title too long' }
  const body = typeof p.body === 'string' ? p.body : ''
  if (body.length > MAX_BODY_LEN) return { ok: false, error: 'body too long' }
  return { ok: true, head, base, title, body }
}

export interface GithubDeps {
  fetchImpl?: typeof fetch
  readToken?: () => string
}

// Extract a short, safe message from a GitHub error response. GitHub error
// bodies never contain the PAT, but we surface only the `message` field (capped)
// rather than the whole body to keep the response tidy and leak-proof.
async function safeGithubMessage(res: { json: () => Promise<any> }, status: number): Promise<string> {
  try {
    const j = await res.json()
    const m = typeof j?.message === 'string' ? j.message : ''
    if (m) return m.slice(0, 300)
  } catch {
    /* fall through */
  }
  return `GitHub error (${status})`
}

// Open a pull request on GATE_REPO. Validates first, then makes exactly ONE
// external call (POST /repos/<GATE_REPO>/pulls). The PAT is read in-process and
// placed only in the Authorization header -- never returned, never logged.
// Dependency-injected (fetch + token reader) so the network path is unit-tested.
export async function openPullRequest(params: OpenPrParams, deps: GithubDeps = {}): Promise<OpenPrResult> {
  const v = validatePrParams(params)
  if (!v.ok) throw new PrRequestError(400, v.error)

  const doFetch = deps.fetchImpl ?? fetch
  const token = (deps.readToken ?? readGithubToken)()

  let res: { ok: boolean; status: number; json: () => Promise<any> }
  try {
    res = await doFetch(`https://api.github.com/repos/${GATE_REPO}/pulls`, {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ head: v.head, base: v.base, title: v.title, body: v.body }),
    })
  } catch {
    // Network/transport failure -- never surface the underlying error (defensive
    // against any chance of echoing request internals).
    throw new PrRequestError(502, 'GitHub request failed')
  }

  if (res.ok) {
    const j = await res.json().catch(() => null)
    const number = j?.number
    const htmlUrl = j?.html_url
    if (typeof number !== 'number' || typeof htmlUrl !== 'string') {
      throw new PrRequestError(502, 'GitHub PR response malformed')
    }
    return { number, htmlUrl, head: v.head, base: v.base }
  }

  // Mask auth/permission failures: they are a server-side credential problem, not
  // the caller's API authorization, so do not pass GitHub's 401/403 through as-is.
  if (res.status === 401 || res.status === 403) {
    throw new PrRequestError(502, 'GitHub authentication/permission error')
  }
  throw new PrRequestError(res.status, await safeGithubMessage(res, res.status))
}

// Fetches the current head.sha and the full changed-file path list for a PR.
export async function fetchPrInfo(pr: number): Promise<GithubPrInfo> {
  const token = readGithubToken()
  const headers = ghHeaders(token)

  const prRes = await fetch(`https://api.github.com/repos/${GATE_REPO}/pulls/${pr}`, { headers })
  if (!prRes.ok) throw new Error(`GitHub PR fetch failed (${prRes.status})`)
  const prJson = (await prRes.json()) as { head?: { sha?: string } }
  const headSha = prJson.head?.sha
  if (typeof headSha !== 'string' || headSha.length === 0) {
    throw new Error('GitHub PR response missing head.sha')
  }

  const files: string[] = []
  for (let page = 1; page <= FILES_PAGE_CAP; page++) {
    const fRes = await fetch(
      `https://api.github.com/repos/${GATE_REPO}/pulls/${pr}/files?per_page=100&page=${page}`,
      { headers },
    )
    if (!fRes.ok) throw new Error(`GitHub PR files fetch failed (${fRes.status})`)
    const arr = (await fRes.json()) as Array<{ filename?: string }>
    for (const f of arr) if (typeof f.filename === 'string') files.push(f.filename)
    if (arr.length < 100) break
  }

  return { headSha, files }
}
