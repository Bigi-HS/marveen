// WS2: GET /api/public-digest -- aggregated fleet status for Live Artifact feed.
//
// Security boundary defined in store/spec-live-artifact-egress-boundary.md (v1.1):
//   - Bearer-guarded (web.ts middleware enforces before this handler is called)
//   - Kill-switch: PUBLIC_DIGEST_ENABLED=false -> 503, read FRESH per request
//   - Rate-limited: 60 req/min per IP via createRateLimiter
//   - ONLY the 11 permitted aggregate fields (spec 3.2); NO raw content, credentials,
//     card titles, message bodies, memory content, or per-session breakdowns
//   - All values are scalars; string values <= 12 chars; no arrays-of-records
import { createRateLimiter } from '../rate-limit.js'
import { rateLimitKey } from '../dashboard-auth.js'
import { listAgentNames } from '../agent-config.js'
import { isAgentRunning, capturePane, agentSessionName, isTmuxSessionAlive } from '../agent-process.js'
import { detectPaneState } from '../../pane-state.js'
import { getNoaDb } from '../../noa-memory.js'
import { getTokenSummary } from '../token-usage.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

type AgentStatus = 'idle' | 'busy' | 'offline'

// 60 req/min per IP: burst=60 tokens, refill=1/s.
const digestLimiter = createRateLimiter({ capacity: 60, refillPerSec: 1 })

// ── Status cache (card beb1d807 pre-golive; Dave finding C on PR#313) ──────────
// resolveAgentStatus shells out to tmux (has-session + capture-pane) ONCE PER
// AGENT. With ~27 agents and up to 60 digest req/min (Live Artifact polling), an
// uncached path spawns ~agents×requests tmux processes/min (~1600/min worst case)
// and loads the host. A short TTL cache collapses repeat resolves within the
// window to a single tmux pass per agent, keeping status fresh enough for a VIEW.
// Tunable via PUBLIC_DIGEST_STATUS_TTL_MS (default 5s); read once at module load.
export const STATUS_TTL_MS = (() => {
  const raw = Number(process.env.PUBLIC_DIGEST_STATUS_TTL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 5000
})()
const statusCache = new Map<string, { status: AgentStatus; expiresAt: number }>()

/** Test-only: clear the status cache so the next resolve recomputes from tmux. */
export function __resetStatusCache(): void {
  statusCache.clear()
}

function computeAgentStatus(name: string): AgentStatus {
  const running = name === MAIN_AGENT_ID
    ? isTmuxSessionAlive(MAIN_CHANNELS_SESSION)
    : isAgentRunning(name)
  if (!running) return 'offline'
  const session = name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
  const pane = capturePane(session)
  if (pane == null) return 'offline'
  const state = detectPaneState(pane)
  // idle -> "idle"; everything else (busy/typing/unknown/error) -> "busy"
  return state === 'idle' ? 'idle' : 'busy'
}

function resolveAgentStatus(name: string, nowMs: number): AgentStatus {
  const cached = statusCache.get(name)
  if (cached && nowMs < cached.expiresAt) return cached.status
  const status = computeAgentStatus(name)
  statusCache.set(name, { status, expiresAt: nowMs + STATUS_TTL_MS })
  return status
}

export async function tryHandlePublicDigest(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/public-digest' || method !== 'GET') return false

  // Kill-switch: read FRESH per request so Forge can flip without a full restart.
  // Spec 4.5 v1.2: falsy = false/0/no/off (case-insensitive). Absent or any other value = enabled.
  const killVal = (process.env.PUBLIC_DIGEST_ENABLED ?? '').toLowerCase()
  if (['false', '0', 'no', 'off'].includes(killVal)) {
    json(res, { error: 'Public digest disabled' }, 503)
    return true
  }

  // Rate-limit: 60 req/min per socket peer (spec 4.4).
  const key = rateLimitKey((req.socket as { remoteAddress?: string } | undefined)?.remoteAddress)
  const rateResult = digestLimiter.allow(key)
  if (!rateResult.allowed) {
    res.setHeader?.('Retry-After', Math.ceil(rateResult.retryAfterMs / 1000).toString())
    json(res, { error: 'Too many requests' }, 429)
    return true
  }

  const db = getNoaDb()
  const nowMs = Date.now()
  const nowS = Math.floor(nowMs / 1000)

  // ── Agents (spec 3.2: {name}.status, {name}.last_active_ts, count_by_status)
  const agentNames = [MAIN_AGENT_ID, ...listAgentNames()]
  const agentsMap: Record<string, { status: AgentStatus; last_active_ts: number }> = {}
  const countByStatus: Record<string, number> = { idle: 0, busy: 0, offline: 0 }

  for (const name of agentNames) {
    const status = resolveAgentStatus(name, nowMs)
    const row = db.prepare(
      'SELECT MAX(created_at) as ts FROM agent_messages WHERE from_agent = ?'
    ).get(name) as { ts: number | null }
    const lastActiveTs = row?.ts ?? 0
    agentsMap[name] = { status, last_active_ts: lastActiveTs }
    countByStatus[status] = (countByStatus[status] ?? 0) + 1
  }

  // ── Kanban (spec 3.2: count_by_column, high_priority_count)
  const kanbanRows = db.prepare(
    "SELECT status, COUNT(*) as cnt FROM kanban_cards GROUP BY status"
  ).all() as { status: string; cnt: number }[]
  const countByColumn: Record<string, number> = { planned: 0, in_progress: 0, waiting: 0, done: 0 }
  for (const r of kanbanRows) {
    if (r.status in countByColumn) countByColumn[r.status] = r.cnt
  }
  const highPriorityCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM kanban_cards WHERE priority IN ('high','urgent') AND status IN ('planned','in_progress','waiting')"
  ).get() as { cnt: number }).cnt

  // ── Schedule (spec 3.2: upcoming_count_24h, next_fire_ts; source = noa.db scheduled_tasks)
  const now24h = nowS + 24 * 60 * 60
  const upcomingCount24h = (db.prepare(
    "SELECT COUNT(*) as cnt FROM scheduled_tasks WHERE next_run >= ? AND next_run <= ? AND status = 'active'"
  ).get(nowS, now24h) as { cnt: number }).cnt
  const nextFireRow = db.prepare(
    "SELECT MIN(next_run) as ts FROM scheduled_tasks WHERE next_run >= ? AND status = 'active'"
  ).get(nowS) as { ts: number | null }
  const nextFireTs = nextFireRow?.ts ?? 0

  // ── Token cost (spec 3.2: total_usd_7d, by_agent; 7d window, no session/model breakdown)
  const sevenDaysAgo = nowS - 7 * 24 * 60 * 60
  const summaries = getTokenSummary(sevenDaysAgo, undefined)
  let totalUsd7d = 0
  const byAgent: Record<string, number> = {}
  for (const s of summaries) {
    totalUsd7d += s.totalCostUsd
    byAgent[s.agent] = s.totalCostUsd
  }

  // ── Activity (spec 3.2: messages_sent_24h, tasks_completed_7d)
  const messagesSent24h = (db.prepare(
    "SELECT COUNT(*) as cnt FROM agent_messages WHERE created_at >= ?"
  ).get(nowS - 24 * 60 * 60) as { cnt: number }).cnt
  const tasksCompleted7d = (db.prepare(
    "SELECT COUNT(*) as cnt FROM kanban_cards WHERE status = 'done' AND updated_at >= ?"
  ).get(sevenDaysAgo) as { cnt: number }).cnt

  json(res, {
    agents: {
      ...agentsMap,
      count_by_status: countByStatus,
    },
    kanban: {
      count_by_column: countByColumn,
      high_priority_count: highPriorityCount,
    },
    schedule: {
      upcoming_count_24h: upcomingCount24h,
      next_fire_ts: nextFireTs,
    },
    token_cost: {
      total_usd_7d: totalUsd7d,
      by_agent: byAgent,
    },
    activity: {
      messages_sent_24h: messagesSent24h,
      tasks_completed_7d: tasksCompleted7d,
    },
  })
  return true
}
