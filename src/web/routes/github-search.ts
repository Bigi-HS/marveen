// GitHub search loopback relay -- GET /api/github-search?q=<query>&max=<n>
//
// n8n workflows query here (Bearer dashboard-token, loopback) instead of
// hitting the GitHub API directly. The PAT never enters n8n's credential
// store; only the dashboard token does (Chad boundary, Option B, card dffd67a3).
//
// Query params: q (required, max 500 chars), max (optional, 1-30, default 10)
// Response: { items: [{ full_name, html_url, description, stargazers_count, pushed_at }] }
//           | { error: string }

import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { logger } from '../../logger.js'
import { PROJECT_ROOT } from '../../config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

function readGithubPat(): string | null {
  const envPath = join(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) return null
  try {
    const content = readFileSync(envPath, 'utf8')
    const m = content.match(/GITHUB_PAT=([^#\s]+)/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

interface GhRepoItem {
  full_name: string
  html_url: string
  description: string | null
  stargazers_count: number
  pushed_at: string
}

export async function tryHandleGithubSearch(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path !== '/api/github-search' || method !== 'GET') return false

  const url = new URL(req.url ?? '/', 'http://localhost')
  const q = url.searchParams.get('q') ?? ''
  const maxRaw = parseInt(url.searchParams.get('max') ?? '10', 10)

  if (!q.trim()) {
    json(res, { error: 'q parameter required' }, 400)
    return true
  }
  if (q.length > 500) {
    json(res, { error: 'q exceeds 500 character limit' }, 400)
    return true
  }
  const max = Math.min(Math.max(isNaN(maxRaw) ? 10 : maxRaw, 1), 30)

  const pat = readGithubPat()
  if (!pat) {
    logger.error('github-search: GITHUB_PAT missing from .env')
    json(res, { error: 'GitHub PAT not configured' }, 503)
    return true
  }

  const ghUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=${max}`
  try {
    const resp = await fetch(ghUrl, {
      headers: {
        Authorization: `token ${pat}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'marveen-fleet/1.0',
      },
    })
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      logger.warn({ status: resp.status, q, path: '/api/github-search' }, 'GitHub API error')
      json(res, { error: `GitHub API ${resp.status}`, detail: errBody.slice(0, 200) }, 502)
      return true
    }
    const data = await resp.json() as { items?: GhRepoItem[] }
    const items = (data.items ?? []).map((r) => ({
      full_name: r.full_name,
      html_url: r.html_url,
      description: r.description ?? '',
      stargazers_count: r.stargazers_count,
      pushed_at: r.pushed_at,
    }))
    json(res, { items })
  } catch (err) {
    logger.error({ err }, 'github-search: network error')
    json(res, { error: 'network error' }, 500)
  }
  return true
}
