// Mechanical merge-gate enforcement -- HTTP routes (/api/gate/*).
//
// ADVISORY BOUNDARY (MG-SEC4): the gate_approvals table uses a caller-supplied
// `reviewer` identity under a shared Bearer token. The `recorded_by` field
// captures the calling agent for audit, but reviewer identity is NOT
// cryptographically authenticated. This gate prevents ACCIDENTAL
// merge-before-approval (the PR #206 incident: Chad PASS present, Dave eng
// sign-off absent, merge succeeded, revert required); it does NOT stop an
// adversarial agent from self-approving as all three reviewers. The hard fix is
// per-agent auth tokens (card 8dac7f1d). The ONE hard enforcement here is the
// head.sha re-verify at merge time (MG-AC6/MG-SEC5): approvals are always
// evaluated against the live GitHub head.sha, so a rebase/new-commit silently
// invalidates every prior approval -- exactly the #206 staleness window.
//
// See store/specs/merge-gate-enforcement.md (card fa11eb63).

import { readBody, json } from '../http-helpers.js'
import { getDb } from '../../db.js'
import type { RouteContext } from './types.js'
import {
  isValidSha,
  isValidReviewer,
  isValidVerdict,
  isPositiveInt,
  runGateCheck,
  type GithubPrInfo,
} from '../gate-check.js'
import {
  insertApproval,
  readApprovals,
  insertOverride,
  hasActiveOverride,
  consumeOverride,
} from '../gate-db.js'
import { fetchPrInfo } from '../github-pr.js'

// The GitHub PR reader is the only network dependency; injectable so route
// tests run without hitting the API (mirrors codetree's rebuild-runner seam).
let prFetcher: (pr: number) => Promise<GithubPrInfo> = fetchPrInfo
export function __setGatePrFetcher(fn: (pr: number) => Promise<GithubPrInfo>): void {
  prFetcher = fn
}

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
