// Server-side GitHub PR-open route (card 5bfe0e1f).
//
// POST /api/github/pr {head, base?, title, body?} -> opens a PR on GATE_REPO with
// the fleet PAT, server-side. Agents reach this over localhost (allowed by the
// external-curl guard); the only external egress is the single pinned PR-create
// call in openPullRequest. The PAT never crosses this boundary -- it is read
// in-process and returned to no one.

import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { openPullRequest, PrRequestError } from '../github-pr.js'
import type { RouteContext } from './types.js'

export async function tryHandleGithub(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, identity } = ctx
  if (path !== '/api/github/pr' || method !== 'POST') return false

  let parsed: { head?: string; base?: string; title?: string; body?: string }
  try {
    const raw = (await readBody(req, { maxBytes: 256 * 1024 })).toString('utf-8')
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    json(res, { error: 'invalid request body' }, 400)
    return true
  }

  try {
    const pr = await openPullRequest({ head: parsed.head ?? '', base: parsed.base, title: parsed.title ?? '', body: parsed.body })
    // Attribute the action to the authenticated caller (card b1ce5118 identity).
    logger.info({ caller: identity.agentId, head: pr.head, base: pr.base, number: pr.number }, 'opened GitHub PR server-side')
    json(res, { number: pr.number, html_url: pr.htmlUrl, head: pr.head, base: pr.base }, 201)
  } catch (err) {
    const status = err instanceof PrRequestError ? err.status : 500
    const message = err instanceof PrRequestError ? err.message : 'PR open failed'
    // Log status only -- never the error internals (defensive against PAT leak).
    logger.warn({ caller: identity.agentId, status }, 'GitHub PR open failed')
    json(res, { error: message }, status)
  }
  return true
}
