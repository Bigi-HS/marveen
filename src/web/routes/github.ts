// Server-side GitHub routes (cards 5bfe0e1f + be1f3711).
//
// POST /api/github/pr   {head, base?, title, body?}
//   Opens a PR on GATE_REPO with the fleet PAT.
//
// POST /api/github/merge {pr_number, head_sha, merge_method?}
//   Merges a PR -- ONLY after runGateCheck passes server-side (MG-SEC4).
//   The 40-char head_sha guard ensures the caller has the live head; if the
//   PR gained a new commit since the caller checked, 409 is returned.
//
// The PAT never crosses these boundaries -- read in-process, returned to no one.

import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { openPullRequest, PrRequestError, fetchPrInfo } from '../github-pr.js'
import { mergePullRequest, MergeRequestError, validateMergeParams } from '../github-merge.js'
import { runGateCheck } from '../gate-check.js'
import { readApprovals, hasActiveOverride, insertPrAuthor } from '../gate-db.js'
import { getDb } from '../../db.js'
import type { RouteContext } from './types.js'

export async function tryHandleGithub(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, identity } = ctx
  if (!path.startsWith('/api/github/')) return false

  // -------------------------------------------------------------------------
  // POST /api/github/merge -- gate-enforced server-side merge (card be1f3711)
  // -------------------------------------------------------------------------
  if (path === '/api/github/merge' && method === 'POST') {
    let parsed: Record<string, unknown>
    try {
      const raw = (await readBody(req, { maxBytes: 4 * 1024 })).toString('utf-8')
      parsed = raw ? JSON.parse(raw) : {}
    } catch {
      json(res, { error: 'invalid request body' }, 400)
      return true
    }

    const v = validateMergeParams({
      pr: typeof parsed['pr_number'] === 'number' ? parsed['pr_number'] : 0,
      headSha: typeof parsed['head_sha'] === 'string' ? parsed['head_sha'] : '',
      mergeMethod: parsed['merge_method'] as any,
    })
    if (!v.ok) {
      json(res, { error: v.error }, 400)
      return true
    }

    // Gate check SERVER-SIDE (MG-SEC4). Fetches live head.sha from GitHub and
    // evaluates all stored approvals against it. A stale approval (rebased PR)
    // does not count -- gate will report it as missing.
    let gateResult: Awaited<ReturnType<typeof runGateCheck>>
    try {
      const db = getDb()
      gateResult = await runGateCheck(v.pr, {
        fetchPr: fetchPrInfo,
        readApprovals: (pr, sha) => readApprovals(db, pr, sha),
        hasActiveOverride: (pr, sha) => hasActiveOverride(db, pr, sha),
      })
    } catch (err) {
      logger.warn({ caller: identity.agentId, pr: v.pr, err }, 'GitHub merge: gate check fetch failed')
      json(res, { error: 'gate check failed: could not fetch PR info from GitHub' }, 502)
      return true
    }

    if (!gateResult.pass) {
      const missing = gateResult.missing.join(', ')
      logger.warn({ caller: identity.agentId, pr: v.pr, missing }, 'GitHub merge: gate not passed')
      json(res, { error: `gate check failed: missing approvals from ${missing}`, gate: gateResult }, 403)
      return true
    }

    // 40-char SHA guard: caller must supply the exact live head SHA so a PR
    // that gained a new commit since they last checked returns 409, not a
    // silent merge of the wrong commit.
    if (gateResult.head_sha !== v.headSha) {
      logger.warn(
        { caller: identity.agentId, pr: v.pr, supplied: v.headSha, live: gateResult.head_sha },
        'GitHub merge: head SHA mismatch -- PR head moved',
      )
      json(res, {
        error: 'head SHA mismatch: PR head has moved since you checked -- re-verify before merging',
        live_head_sha: gateResult.head_sha,
      }, 409)
      return true
    }

    try {
      const result = await mergePullRequest({ pr: v.pr, headSha: v.headSha, mergeMethod: v.mergeMethod })
      logger.info(
        { caller: identity.agentId, pr: v.pr, sha: result.sha, mergeMethod: v.mergeMethod },
        'merged GitHub PR server-side',
      )
      json(res, { merged: true, sha: result.sha, message: result.message }, 200)
    } catch (err) {
      const status = err instanceof MergeRequestError ? err.status : 500
      const message = err instanceof MergeRequestError ? err.message : 'merge failed'
      logger.warn({ caller: identity.agentId, pr: v.pr, status }, 'GitHub merge failed')
      json(res, { error: message }, status)
    }
    return true
  }

  // -------------------------------------------------------------------------
  // POST /api/github/pr -- server-side PR open (card 5bfe0e1f)
  // -------------------------------------------------------------------------
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
    // Record author for MG-SEC5 self-approval block (card ec818352). INSERT OR IGNORE
    // so a re-open by a different agent does not override the original author record.
    try {
      insertPrAuthor(getDb(), pr.number, identity.agentId, Math.floor(Date.now() / 1000))
    } catch (err) {
      logger.warn({ err, pr: pr.number }, 'Failed to record PR author (non-fatal, MG-SEC5 fail-open)')
    }
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
