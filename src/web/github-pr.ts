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
