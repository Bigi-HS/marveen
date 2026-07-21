// GET /api/gate/board -- read-only aggregation of the merge-gate state across
// every PR with recent gate activity (meeting WS-A, card 87c32aa4).
//
// Design constraints (from the card + Genesis review):
//   - DB-ONLY: aggregates purely from the stored gate tables (gate_approvals /
//     gate_ci_runs / gate_overrides / gate_pr_authors). It makes ZERO GitHub
//     calls per request, so it can never hit the GitHub rate-limit.
//   - No secrets in the payload: head_sha, PAT and tokens are NEVER serialized;
//     only pr_number / author / per-seat status / ci_status / merge-ready badge.
//   - TTL-cached (default 30s, GATE_BOARD_CACHE_TTL_MS) mirroring the
//     public-digest status-cache (commit 3888382), invalidated immediately on any
//     'gate' event (approve/block/override) so a fresh verdict shows at once.
//
// NON-AUTHORITATIVE BY DESIGN: this is an OVERVIEW, not the gate. The real merge
// path re-runs runGateCheck (GET /api/gate/check), which fetches the PR file list
// from GitHub to decide whether Chad is required. The board cannot see that file
// list, so it derives `required` from the DB alone: thor+dave always, plus chad
// IFF chad has already recorded a verdict (chad-acted => chad-was-required). The
// one divergence this leaves is a security-sensitive PR where Chad has not yet
// reviewed: the board may show merge_ready=true while /api/gate/check would still
// require Chad. `chad_reviewed` surfaces that uncertainty, and because the board
// never gates an actual merge, this can only ever be a display hint -- the merge
// endpoint re-checks authoritatively.
import type Database from 'better-sqlite3'
import { getDb } from '../../db.js'
import { json } from '../http-helpers.js'
import { subscribeDashboardEvents } from '../../event-bus.js'
import {
  evaluateApprovals,
  applyAuthorRecusal,
  resolveCiStatus,
  isGateCiRequired,
  type Reviewer,
  type CiStatus,
} from '../gate-check.js'
import { readApprovals, readLatestCiRun, hasActiveOverride, readPrAuthor } from '../gate-db.js'
import type { RouteContext } from './types.js'

export type Seat = 'approved' | 'blocked' | 'none'

export interface GateBoardPr {
  pr_number: number
  author: string | null
  seats: Record<Reviewer, Seat>
  ci_status: CiStatus
  ci_required: boolean
  override_active: boolean
  /** True once Chad has recorded any verdict on the latest sha (see file header). */
  chad_reviewed: boolean
  merge_ready: boolean
  /** Newest recorded_at across this PR's gate rows (epoch seconds). */
  last_activity: number
}

export interface GateBoard {
  generated_at: number
  ttl_ms: number
  window_days: number
  prs: GateBoardPr[]
}

// Only surface PRs with gate activity inside this rolling window. The gate DB
// stores no open/closed/merged state, so a time window is the DB-only proxy for
// "still relevant" (a merged PR stops accruing gate rows and ages out).
const WINDOW_DAYS = (() => {
  const raw = Number(process.env.GATE_BOARD_WINDOW_DAYS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 14
})()

const MAX_PRS = 200

export const GATE_BOARD_TTL_MS = (() => {
  const raw = Number(process.env.GATE_BOARD_CACHE_TTL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 30000
})()

interface ActivityRow {
  pr_number: number
  head_sha: string
  recorded_at: number
}

// Blocked is sticky (mirrors evaluateApprovals): a block on a reviewer wins over
// any later approve on the same sha.
function seatFor(approvals: Array<{ reviewer: string; verdict: string }>, reviewer: Reviewer): Seat {
  let approved = false
  for (const a of approvals) {
    if (a.reviewer !== reviewer) continue
    if (a.verdict === 'blocked') return 'blocked'
    if (a.verdict === 'approved') approved = true
  }
  return approved ? 'approved' : 'none'
}

/**
 * Pure aggregation over the gate tables. Exported for unit tests; the route
 * wraps it in the TTL cache. `nowS` is epoch seconds (injected for testability).
 */
export function computeGateBoard(db: Database.Database, nowS: number): GateBoard {
  const cutoff = nowS - WINDOW_DAYS * 24 * 60 * 60

  // One DB-only sweep of every (pr, sha, ts) touchpoint across the three tables.
  const rows = db
    .prepare(
      `SELECT pr_number, head_sha, recorded_at FROM gate_approvals
       UNION ALL SELECT pr_number, head_sha, recorded_at FROM gate_ci_runs
       UNION ALL SELECT pr_number, head_sha, recorded_at FROM gate_overrides`,
    )
    .all() as ActivityRow[]

  // Reduce to each PR's latest head_sha + last activity. Approvals are per-sha,
  // so seats MUST be read at the latest sha -- a new push (newer row, new sha)
  // invalidates approvals recorded against the old sha.
  const latest = new Map<number, { sha: string; lastActivity: number }>()
  for (const r of rows) {
    const cur = latest.get(r.pr_number)
    if (!cur || r.recorded_at >= cur.lastActivity) {
      latest.set(r.pr_number, { sha: r.head_sha, lastActivity: r.recorded_at })
    }
  }

  const ciRequired = isGateCiRequired()
  const prs: GateBoardPr[] = []
  for (const [prNumber, { sha, lastActivity }] of latest) {
    if (lastActivity < cutoff) continue
    const approvals = readApprovals(db, prNumber, sha)
    const seats: Record<Reviewer, Seat> = {
      thor: seatFor(approvals, 'thor'),
      dave: seatFor(approvals, 'dave'),
      chad: seatFor(approvals, 'chad'),
    }
    const chadReviewed = seats.chad !== 'none'
    const overrideActive = hasActiveOverride(db, prNumber, sha)
    const ciStatus = resolveCiStatus(readLatestCiRun(db, prNumber, sha))
    const prAuthor = readPrAuthor(db, prNumber)
    // Mirror runGateCheck's pass semantics with a DB-derived `required` set, then
    // apply author recusal (card 46de122b) so the board's merge_ready matches the
    // merge route: a reviewer-author is dropped and the backup (chad) promoted.
    const baseRequired: Reviewer[] = chadReviewed ? ['thor', 'dave', 'chad'] : ['thor', 'dave']
    const required = applyAuthorRecusal(baseRequired, prAuthor).required
    const evaluation = evaluateApprovals(approvals, required)
    const ciSatisfied = ciRequired ? ciStatus === 'pass' : true
    const mergeReady = overrideActive ? true : evaluation.pass && ciSatisfied
    prs.push({
      pr_number: prNumber,
      author: prAuthor,
      seats,
      ci_status: ciStatus,
      ci_required: ciRequired,
      override_active: overrideActive,
      chad_reviewed: chadReviewed,
      merge_ready: mergeReady,
      last_activity: lastActivity,
    })
  }
  prs.sort((a, b) => b.pr_number - a.pr_number)
  return { generated_at: nowS, ttl_ms: GATE_BOARD_TTL_MS, window_days: WINDOW_DAYS, prs: prs.slice(0, MAX_PRS) }
}

let cache: { value: GateBoard; expiresAt: number } | null = null

/** Test-only: drop the cached board so the next read recomputes. */
export function __resetGateBoardCache(): void {
  cache = null
}

// Invalidate on any gate mutation (approve/block/override) so a fresh verdict is
// visible immediately, independent of the TTL. Subscribed once for the process
// lifetime (single-node server); the handler never unsubscribes.
subscribeDashboardEvents((e) => {
  if (e.type === 'gate') cache = null
})

function resolveBoard(nowMs: number): GateBoard {
  if (cache && nowMs < cache.expiresAt) return cache.value
  const value = computeGateBoard(getDb(), Math.floor(nowMs / 1000))
  cache = { value, expiresAt: nowMs + GATE_BOARD_TTL_MS }
  return value
}

export async function tryHandleGateBoard(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== '/api/gate/board' || method !== 'GET') return false
  json(res, resolveBoard(Date.now()))
  return true
}
