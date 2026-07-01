// Mechanical merge-gate enforcement -- HTTP routes (/api/gate/*).
//
// MG-SEC4 ENFORCED (card db9bc192, C-BIND): reviewer identity is now bound to
// the per-agent Bearer token. A per-agent token may only record its OWN
// approval; it cannot forge Thor's or Chad's sign-off. Admin/operator tokens
// retain relay capability (NoA fills Dave-seat on author-deferral PRs).
// Prior to C-BIND, reviewer was advisory (caller-supplied, not verified):
// the PR #206 incident (stale approval merged before Dave signed off) was
// prevented by the head.sha re-verify at merge time (MG-AC6/MG-SEC5), but
// self-approval impersonation remained possible. C-BIND closes that gap.
//
// See store/specs/merge-gate-enforcement.md (card fa11eb63).

import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { getDb } from '../../db.js'
import { emitDashboardEvent } from '../../event-bus.js'
import type { RouteContext } from './types.js'
import {
  isValidSha,
  isValidReviewer,
  isValidVerdict,
  isValidCiStatus,
  isPositiveInt,
  isGateCiRequired,
  resolveCiStatus,
  runGateCheck,
  type GithubPrInfo,
} from '../gate-check.js'
import {
  insertApproval,
  readApprovals,
  insertOverride,
  hasActiveOverride,
  consumeOverride,
  readPrAuthor,
  insertCiRun,
  readLatestCiRun,
} from '../gate-db.js'
import { hasScope, ADMIN_SCOPE } from '../agent-token-registry.js'
import { fetchPrInfo } from '../github-pr.js'

// The GitHub PR reader is the only network dependency; injectable so route
// tests run without hitting the API (mirrors codetree's rebuild-runner seam).
let prFetcher: (pr: number) => Promise<GithubPrInfo> = fetchPrInfo
export function __setGatePrFetcher(fn: (pr: number) => Promise<GithubPrInfo>): void {
  prFetcher = fn
}

// The independent CI runner identity (card 0c166e48). Only this agent's token
// (or an admin/operator relay) may post a CI run, so the author cannot self-post.
const CI_RUNNER = 'buster'

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000)
}

async function parseJsonBody(req: RouteContext['req']): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await readBody(req)).toString('utf-8')
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function tryHandleGate(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (!path.startsWith('/api/gate/')) return false

  // MG-SEC3 -- append-only: no mutation API for gate state. Any DELETE/PATCH on
  // a gate resource is rejected before it can reach a handler.
  if (method === 'DELETE' || method === 'PATCH') {
    json(res, { error: 'gate state is append-only; DELETE/PATCH not allowed' }, 405)
    return true
  }

  // MG-AC2 -- record a reviewer verdict.
  if (path === '/api/gate/approve' && method === 'POST') {
    const body = await parseJsonBody(req)
    if (!body) {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    const { pr_number, head_sha, reviewer, verdict } = body
    if (!isPositiveInt(pr_number)) {
      json(res, { error: 'pr_number must be a positive integer' }, 400)
      return true
    }
    if (!isValidSha(head_sha)) {
      json(res, { error: 'head_sha must be exactly 40 hex characters' }, 400)
      return true
    }
    if (!isValidReviewer(reviewer)) {
      json(res, { error: "reviewer must be one of 'thor', 'dave', 'chad'" }, 400)
      return true
    }
    // MG-SEC4 BLOCK (card db9bc192, C-BIND): a per-agent token may only record
    // its OWN approval. Admin/operator tokens may relay any reviewer (e.g. NoA
    // filling Dave-seat on author-deferral PRs). Absent identity (unit tests
    // using the route directly without auth middleware) is treated as admin.
    const { identity } = ctx
    if (identity && identity.source !== 'operator' && !hasScope(identity.scopes, ADMIN_SCOPE)) {
      if (identity.agentId !== reviewer) {
        logger.warn(
          { tokenAgent: identity.agentId, reviewer },
          'Gate reviewer binding: token/reviewer mismatch rejected (MG-SEC4)',
        )
        json(res, { error: `token identity (${identity.agentId}) may not record approval as ${reviewer}` }, 403)
        return true
      }
    }
    // MG-SEC5: self-approval block (card ec818352). A per-agent token may not
    // record its own approval on a PR it authored. Admin/operator tokens bypass
    // (author-deferral relay: NoA fills Dave-seat for Dave-authored PRs). Fail-open
    // when no author record exists (old PRs opened before this table was added).
    if (identity && identity.source !== 'operator' && !hasScope(identity.scopes, ADMIN_SCOPE)) {
      const prAuthor = readPrAuthor(getDb(), pr_number)
      if (prAuthor != null && identity.agentId === prAuthor) {
        logger.warn(
          { agent: identity.agentId, pr: pr_number },
          'Gate self-approval blocked (MG-SEC5): reviewer is PR author',
        )
        json(res, { error: `self-approval blocked: ${identity.agentId} is the PR author (MG-SEC5)` }, 403)
        return true
      }
    }

    if (!isValidVerdict(verdict)) {
      json(res, { error: "verdict must be one of 'approved', 'blocked'" }, 400)
      return true
    }
    // recorded_by is advisory (see boundary note above): caller-supplied, no
    // per-agent HTTP identity under the shared token. recorded_at is hard
    // server-side.
    const recordedBy = typeof body['recorded_by'] === 'string' ? (body['recorded_by'] as string) : 'unknown'
    const note = typeof body['note'] === 'string' ? (body['note'] as string) : null
    const row = insertApproval(
      getDb(),
      { pr_number, head_sha, reviewer, verdict, recorded_by: recordedBy, note },
      nowEpoch(),
    )
    // F1 realtime (card 513b8fd6): broadcast a thin-notify gate event so the
    // dashboard refreshes its gate panel live. ID-ONLY -- pr_number + verdict
    // action, never the note/sha/reviewer content (Trap-2: the SSE frame is a
    // refetch trigger, not a content channel). Mirrors the kanban/board emits.
    emitDashboardEvent({ type: 'gate', id: String(pr_number), action: verdict })
    json(res, row, 201)
    return true
  }

  // Card 0c166e48 -- independent pre-gate CI post (Buster-CI). IDENTITY-BOUND:
  // only Buster's own token may post a CI run (admin/operator tokens may relay).
  // This is the load-bearing property: a PR author cannot forge their own CI
  // PASS, so the CI signal is genuinely independent of the author.
  if (path === '/api/gate/ci' && method === 'POST') {
    const body = await parseJsonBody(req)
    if (!body) {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    const { pr_number, head_sha, status } = body
    if (!isPositiveInt(pr_number)) {
      json(res, { error: 'pr_number must be a positive integer' }, 400)
      return true
    }
    if (!isValidSha(head_sha)) {
      json(res, { error: 'head_sha must be exactly 40 hex characters' }, 400)
      return true
    }
    if (!isValidCiStatus(status)) {
      json(res, { error: "status must be one of 'pass', 'fail'" }, 400)
      return true
    }
    // Identity binding: a per-agent token may only post as the CI runner
    // (buster). Admin/operator tokens may relay. Absent identity (unit tests
    // without auth middleware) is treated as admin.
    const { identity } = ctx
    if (identity && identity.source !== 'operator' && !hasScope(identity.scopes, ADMIN_SCOPE)) {
      if (identity.agentId !== CI_RUNNER) {
        logger.warn(
          { tokenAgent: identity.agentId },
          'Gate CI post binding: only the CI runner (buster) may post (rejected)',
        )
        json(res, { error: `token identity (${identity.agentId}) may not post a CI run; only ${CI_RUNNER} may` }, 403)
        return true
      }
    }
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)
    const recordedBy = typeof body['recorded_by'] === 'string' ? (body['recorded_by'] as string) : (identity?.agentId ?? CI_RUNNER)
    const note = typeof body['note'] === 'string' ? (body['note'] as string) : null
    const row = insertCiRun(
      getDb(),
      {
        pr_number,
        head_sha,
        status,
        tsc_ok: num(body['tsc_ok']),
        tests_pass: num(body['tests_pass']),
        tests_fail: num(body['tests_fail']),
        diff_files: num(body['diff_files']),
        insertions: num(body['insertions']),
        deletions: num(body['deletions']),
        recorded_by: recordedBy,
        note,
      },
      nowEpoch(),
    )
    json(res, row, 201)
    return true
  }

  // MG-AC3 / MG-AC6 -- preflight gate check against the live head.sha.
  if (path === '/api/gate/check' && method === 'GET') {
    const prRaw = url.searchParams.get('pr')
    const pr = prRaw != null ? Number(prRaw) : NaN
    if (!isPositiveInt(pr)) {
      json(res, { error: 'pr query parameter must be a positive integer' }, 400)
      return true
    }
    const db = getDb()
    try {
      const result = await runGateCheck(pr, {
        fetchPr: prFetcher,
        readApprovals: (p, sha) => readApprovals(db, p, sha),
        hasActiveOverride: (p, sha) => hasActiveOverride(db, p, sha),
        // Card 0c166e48: independent CI status for the live head, gated by the
        // GATE_CI_REQUIRED rollout flag (default off = observability only).
        ciStatus: (p, sha) => resolveCiStatus(readLatestCiRun(db, p, sha)),
        ciRequired: isGateCiRequired(),
      })
      json(res, result)
    } catch (err) {
      json(res, { error: 'gate check failed', detail: err instanceof Error ? err.message : String(err) }, 502)
    }
    return true
  }

  // MG-AC7 -- Boss-level emergency override.
  if (path === '/api/gate/override' && method === 'POST') {
    const body = await parseJsonBody(req)
    if (!body) {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    const { pr_number, head_sha, reason } = body
    if (!isPositiveInt(pr_number)) {
      json(res, { error: 'pr_number must be a positive integer' }, 400)
      return true
    }
    if (!isValidSha(head_sha)) {
      json(res, { error: 'head_sha must be exactly 40 hex characters' }, 400)
      return true
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      json(res, { error: 'reason is required' }, 400)
      return true
    }
    const recordedBy = typeof body['recorded_by'] === 'string' ? (body['recorded_by'] as string) : 'unknown'
    const { id } = insertOverride(getDb(), { pr_number, head_sha, reason, recorded_by: recordedBy }, nowEpoch())
    json(res, { id, active: true }, 201)
    return true
  }

  // MG-AC7 -- consume an override after a successful merge (single-use).
  if (path === '/api/gate/consume-override' && method === 'POST') {
    const body = await parseJsonBody(req)
    if (!body) {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    const { pr_number, head_sha } = body
    if (!isPositiveInt(pr_number)) {
      json(res, { error: 'pr_number must be a positive integer' }, 400)
      return true
    }
    if (!isValidSha(head_sha)) {
      json(res, { error: 'head_sha must be exactly 40 hex characters' }, 400)
      return true
    }
    const outcome = consumeOverride(getDb(), pr_number, head_sha, nowEpoch())
    if (outcome === 'notfound') {
      json(res, { error: 'no override found for this (pr_number, head_sha)' }, 404)
      return true
    }
    json(res, { consumed: true }, 200)
    return true
  }

  return false
}
