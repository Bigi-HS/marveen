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
import { openPullRequest, closePullRequest, PrRequestError, fetchPrInfo, type ClosePrResult } from '../github-pr.js'
import { mergePullRequest, MergeRequestError, validateMergeParams } from '../github-merge.js'
import { runGateCheck, resolveCiStatus, isGateCiRequired, type GithubPrInfo } from '../gate-check.js'
import { readApprovals, hasActiveOverride, insertPrAuthor, readPrAuthor, readLatestCiRun } from '../gate-db.js'
import { getDb } from '../../db.js'
import type { RouteContext } from './types.js'

// The two network dependencies of the gate-enforced merge -- the live-head PR
// fetcher and the GitHub merge call -- are injectable so the /api/github/merge
// gate branch (403 missing/blocked, 409 head-moved) is testable in-process
// without hitting GitHub. Mirrors gate.ts's __setGatePrFetcher seam. Defaults
// are the real functions; production behaviour is unchanged.
let mergePrFetcher: (pr: number) => Promise<GithubPrInfo> = fetchPrInfo
let mergeRunner: typeof mergePullRequest = mergePullRequest
let closeRunner: (pr: number) => Promise<ClosePrResult> = closePullRequest
export function __setGithubMergeDeps(deps: {
  fetchPr?: (pr: number) => Promise<GithubPrInfo>
  merge?: typeof mergePullRequest
  close?: (pr: number) => Promise<ClosePrResult>
}): void {
  if (deps.fetchPr) mergePrFetcher = deps.fetchPr
  if (deps.merge) mergeRunner = deps.merge
  if (deps.close) closeRunner = deps.close
}
export function __resetGithubMergeDeps(): void {
  mergePrFetcher = fetchPrInfo
  mergeRunner = mergePullRequest
  closeRunner = closePullRequest
}

// PR-open seam (card ef840006): injectable for tests to avoid real network
// and DB calls.  Production defaults are the real implementations.
let prOpener: typeof openPullRequest = openPullRequest
let prAuthorRecorder: (prNumber: number, agentId: string, now: number) => void = (n, a, t) =>
  insertPrAuthor(getDb(), n, a, t)

export function __setGithubPrDeps(deps: {
  openPr?: typeof openPullRequest
  recordAuthor?: (prNumber: number, agentId: string, now: number) => void
}): void {
  if (deps.openPr !== undefined) prOpener = deps.openPr
  if (deps.recordAuthor !== undefined) prAuthorRecorder = deps.recordAuthor
}
export function __resetGithubPrDeps(): void {
  prOpener = openPullRequest
  prAuthorRecorder = (n, a, t) => insertPrAuthor(getDb(), n, a, t)
}

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
        fetchPr: mergePrFetcher,
        readApprovals: (pr, sha) => readApprovals(db, pr, sha),
        hasActiveOverride: (pr, sha) => hasActiveOverride(db, pr, sha),
        // Card 0c166e48: merge-time inherits the independent-CI requirement, so a
        // required-and-missing CI PASS blocks the merge exactly as it blocks
        // /api/gate/check. Gated by GATE_CI_REQUIRED (default off).
        ciStatus: (pr, sha) => resolveCiStatus(readLatestCiRun(db, pr, sha)),
        ciRequired: isGateCiRequired(),
        // Author recusal (card 46de122b): a reviewer-author is dropped from the
        // required seats and the backup (chad) promoted, so an author-recused PR
        // is no longer deadlocked at auto-merge. Trusted identity-bound record.
        readAuthor: (prNum) => readPrAuthor(db, prNum),
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
      const result = await mergeRunner({ pr: v.pr, headSha: v.headSha, mergeMethod: v.mergeMethod })
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
  // POST /api/github/pr/close -- server-side PR close (card 58f79330)
  // Enables token-bound re-open recovery: close a mis-authored PR so the real
  // author can re-open the same head with their own token. Close-only,
  // GATE_REPO-pinned, identity-logged -- minimal blast radius.
  // -------------------------------------------------------------------------
  if (path === '/api/github/pr/close' && method === 'POST') {
    let parsed: Record<string, unknown>
    try {
      const raw = (await readBody(req, { maxBytes: 4 * 1024 })).toString('utf-8')
      parsed = raw ? JSON.parse(raw) : {}
    } catch {
      json(res, { error: 'invalid request body' }, 400)
      return true
    }

    const prNum = typeof parsed['pr_number'] === 'number' ? parsed['pr_number'] : 0
    if (!Number.isInteger(prNum) || prNum <= 0) {
      json(res, { error: 'pr_number must be a positive integer' }, 400)
      return true
    }

    try {
      const result = await closeRunner(prNum)
      logger.info({ caller: identity.agentId, pr: prNum, state: result.state }, 'closed GitHub PR server-side')
      json(res, { closed: true, number: result.number, state: result.state }, 200)
    } catch (err) {
      const status = err instanceof PrRequestError ? err.status : 500
      const message = err instanceof PrRequestError ? err.message : 'PR close failed'
      logger.warn({ caller: identity.agentId, pr: prNum, status }, 'GitHub PR close failed')
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
    const pr = await prOpener({ head: parsed.head ?? '', base: parsed.base, title: parsed.title ?? '', body: parsed.body })
    // Attribute the action to the authenticated caller (card b1ce5118 identity).
    logger.info({ caller: identity.agentId, head: pr.head, base: pr.base, number: pr.number }, 'opened GitHub PR server-side')
    // Record author for MG-SEC5 self-approval block (card ec818352). INSERT OR IGNORE
    // so a re-open by a different agent does not override the original author record.
    try {
      prAuthorRecorder(pr.number, identity.agentId, Math.floor(Date.now() / 1000))
    } catch (err) {
      logger.warn({ err, pr: pr.number }, 'Failed to record PR author (non-fatal, MG-SEC5 fail-open)')
    }
    // Card ef840006: include the recorded author in the response so callers can
    // detect identity fallback (operator token used instead of per-agent token).
    const body: Record<string, unknown> = {
      number: pr.number,
      html_url: pr.htmlUrl,
      head: pr.head,
      base: pr.base,
      recorded_author: identity.agentId,
    }
    if (identity.source === 'operator') {
      body.author_warning =
        'operator token used -- recorded author may not reflect the actual caller; use a per-agent token for correct recusal'
    }
    json(res, body, 201)
  } catch (err) {
    const status = err instanceof PrRequestError ? err.status : 500
    const message = err instanceof PrRequestError ? err.message : 'PR open failed'
    // Log status only -- never the error internals (defensive against PAT leak).
    logger.warn({ caller: identity.agentId, status }, 'GitHub PR open failed')
    json(res, { error: message }, status)
  }
  return true
}
