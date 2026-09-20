import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, MAIN_AGENT_ID, BOT_NAME } from '../../config.js'
import { getDb, countTaskRunsBetween, startOfBudapestDayMs } from '../../db.js'
import {
  agentDir, listAgentNames, readAgentDisplayName,
} from '../agent-config.js'
import { readAgentTeam } from '../agent-team.js'
import { isAgentRunning } from '../agent-process.js'
import { json } from '../http-helpers.js'
import { toPriorityString, type PriorityValue } from '../../priority.js'
import type { RouteContext } from './types.js'

// Count "real" user turns (operator prompts, Telegram messages) in every
// Claude Code session JSONL under ~/.claude/projects/. Filters out
// tool_result, local-command, and synthetic system events so a task-heavy
// hour doesn't inflate the counter.
function countUserTurns(fromMs: number, toMs: number = Number.POSITIVE_INFINITY): number {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return 0
  let total = 0
  try {
    for (const projectDir of readdirSync(root)) {
      const absDir = join(root, projectDir)
      let stat: ReturnType<typeof statSync>
      try { stat = statSync(absDir) } catch { continue }
      if (!stat.isDirectory()) continue
      for (const fname of readdirSync(absDir)) {
        if (!fname.endsWith('.jsonl')) continue
        const absFile = join(absDir, fname)
        let fstat: ReturnType<typeof statSync>
        try { fstat = statSync(absFile) } catch { continue }
        if (fstat.mtimeMs < fromMs) continue
        try {
          const data = readFileSync(absFile, 'utf-8')
          for (const line of data.split('\n')) {
            if (!line) continue
            let e: any
            try { e = JSON.parse(line) } catch { continue }
            if (e.type !== 'user' || e.isMeta) continue
            const ts = e.timestamp ? Date.parse(e.timestamp) : 0
            if (!ts || ts < fromMs || ts >= toMs) continue
            const content = e.message?.content
            if (typeof content === 'string') {
              if (content.startsWith('<local-command') || content.startsWith('<command-name>')) continue
              total++
            } else if (Array.isArray(content)) {
              const hasToolResult = content.some((b: any) => b && b.type === 'tool_result')
              if (hasToolResult) continue
              total++
            }
          }
        } catch { /* skip unreadable file */ }
      }
    }
  } catch { /* ignore */ }
  return total
}

// Injectable seam for the "tasks today/yesterday" figures so the day-boundary
// and the source-combining arithmetic are unit-testable without a DB or the
// filesystem (WELL-027 C4).
export interface OverviewCountDeps {
  /** Absolute wall-clock now in epoch ms. */
  nowMs: () => number
  /** Scheduled task_runs in [from, to). Defaults to the live noa.db counter. */
  countTaskRuns: (from: number, to?: number) => number
  /** Session-JSONL user-turns in [from, to). Defaults to the live scanner. */
  countUserTurns: (from: number, to?: number) => number
}

export interface OverviewCounts {
  tasksToday: number
  tasksYesterday: number
  /** Budapest-pinned start-of-today, epoch ms (the "today" window start). */
  startOfDayMs: number
}

/**
 * Combine the scheduled-task and user-turn counters into the overview's
 * "tasks today/yesterday" figures.
 *
 * C4b: the day boundary is pinned to Europe/Budapest via startOfBudapestDayMs,
 * not the ambient server TZ.
 *
 * C4a KNOWN LIMITATION: tasksToday/tasksYesterday are the ARITHMETIC SUM of two
 * independently-counted, NOT-disjoint sources -- a scheduled task writes a
 * task_runs row AND its dispatched prompt can also appear as a user-turn in a
 * session JSONL, so one logical activity is counted in both. This overcount is
 * bounded and intentional here; event-identity dedup is tracked separately in
 * card 2fbfdb39. See overview-counts.test.ts (C4a) which pins this behavior.
 */
export function computeOverviewCounts(deps: OverviewCountDeps): OverviewCounts {
  const startTs = startOfBudapestDayMs(deps.nowMs())
  // Fixed 24h window before today's boundary. Faithful to the pre-C4 behavior;
  // may drift by an hour on the two DST-transition nights, which is immaterial
  // to an activity counter (the today boundary is what C4b pins).
  const yesterday = startTs - 24 * 60 * 60 * 1000
  const schedToday = deps.countTaskRuns(startTs)
  const schedYesterday = deps.countTaskRuns(yesterday, startTs)
  const userTurns = deps.countUserTurns(startTs)
  const userTurnsPrev = deps.countUserTurns(yesterday, startTs)
  return {
    tasksToday: schedToday + userTurns,
    tasksYesterday: schedYesterday + userTurnsPrev,
    startOfDayMs: startTs,
  }
}

export async function tryHandleOverview(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/overview' && method === 'GET') {
    const subAgents = listAgentNames()
    const running = subAgents.filter(n => isAgentRunning(n)).length + 1
    const total = subAgents.length + 1

    const db0 = getDb()
    const memStats = db0.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }
    const memCats = db0.prepare("SELECT COUNT(DISTINCT category) as c FROM memories").get() as { c: number }

    const { tasksToday, tasksYesterday, startOfDayMs: startTs } = computeOverviewCounts({
      nowMs: () => Date.now(),
      countTaskRuns: countTaskRunsBetween,
      countUserTurns,
    })

    let skillCount = 0
    let skillsToday = 0
    const skillsDir = join(homedir(), '.claude', 'skills')
    if (existsSync(skillsDir)) {
      for (const entry of readdirSync(skillsDir)) {
        const skillFile = join(skillsDir, entry, 'SKILL.md')
        if (existsSync(skillFile)) {
          skillCount++
          try {
            const mtime = statSync(skillFile).mtimeMs
            if (mtime >= startTs) skillsToday++
          } catch { /* ignore */ }
        }
      }
    }

    // status/priority are only meaningful for the inter-agent-message rows
    // (memories carry neither), so they are optional on the activity item.
    // priority is normalized to its TEXT tier (low/normal/high/urgent) via the
    // shared helper so the frontend gets a stable enum regardless of whether the
    // live column stores the migrated INTEGER (25/50/75/100) or the legacy TEXT.
    const activity: Array<{
      icon: string
      text: string
      at: number
      status?: 'pending' | 'delivered' | 'done' | 'failed'
      priority?: 'low' | 'normal' | 'high' | 'urgent'
    }> = []
    try {
      const memRows = db0.prepare("SELECT content, created_at, agent_id FROM memories ORDER BY created_at DESC LIMIT 6").all() as { content: string; created_at: number; agent_id: string }[]
      for (const r of memRows) {
        activity.push({
          icon: 'memory',
          text: `${r.agent_id}: ${r.content.slice(0, 80)}${r.content.length > 80 ? '…' : ''}`,
          at: r.created_at * 1000,
        })
      }
    } catch { /* ignore */ }
    try {
      const msgRows = db0.prepare("SELECT from_agent, to_agent, content, created_at, status, priority FROM agent_messages ORDER BY created_at DESC LIMIT 4").all() as { from_agent: string; to_agent: string; content: string; created_at: number; status: string; priority: PriorityValue | null }[]
      const knownStatus = new Set(['pending', 'delivered', 'done', 'failed'])
      for (const r of msgRows) {
        activity.push({
          icon: 'delegate',
          text: `${r.from_agent} → ${r.to_agent}: ${r.content.slice(0, 60)}${r.content.length > 60 ? '…' : ''}`,
          at: r.created_at * 1000,
          status: knownStatus.has(r.status) ? (r.status as 'pending' | 'delivered' | 'done' | 'failed') : undefined,
          priority: toPriorityString(r.priority),
        })
      }
    } catch { /* ignore */ }
    activity.sort((a, b) => b.at - a.at)

    const agentsForTeam: Array<{ id: string; label: string; role: string; running: boolean; hasAvatar: boolean; avatarUrl: string }> = []
    const mainHasAvatar = [
      join(PROJECT_ROOT, 'store', 'marveen-avatar.png'),
      join(PROJECT_ROOT, 'store', 'marveen-avatar.jpg'),
    ].some(existsSync)
    agentsForTeam.push({
      id: MAIN_AGENT_ID,
      label: BOT_NAME,
      role: 'main',
      running: true,
      hasAvatar: mainHasAvatar,
      avatarUrl: `/api/marveen/avatar`,
    })
    for (const a of subAgents) {
      const team = readAgentTeam(a)
      agentsForTeam.push({
        id: a,
        label: readAgentDisplayName(a),
        role: team.role,
        running: isAgentRunning(a),
        hasAvatar: existsSync(join(agentDir(a), 'avatar.png')),
        avatarUrl: `/api/agents/${encodeURIComponent(a)}/avatar`,
      })
    }
    json(res, {
      agents: { total, running },
      tasksToday,
      tasksYesterday,
      memories: { count: memStats.c, categories: memCats.c },
      skills: { count: skillCount, today: skillsToday },
      team: agentsForTeam,
      activity: activity.slice(0, 8),
    })
    return true
  }

  return false
}
