import type { AgentSummary, AgentHealth, AgentGridItem } from '@/types/api'
import { liveStatusFromHealth } from './status'

/**
 * Join the agent roster (GET /api/agents) with the health board
 * (GET /api/agents/health) into the HOME grid view model (AC-F0-3/AC-F0-4).
 *
 * - The roster is the canonical list: every agent from /api/agents is displayed.
 * - The main orchestrator (health.isMain) is surfaced first even if it is not in
 *   the sub-agent roster, so Mission Control shows the whole fleet.
 * - Live status comes from the health board; an agent with no health record falls
 *   back to "offline" when not running and "unknown" otherwise.
 *
 * Pure: no fetch, no DOM -- unit-testable with plain arrays.
 */
export function mergeAgentStatus(agents: AgentSummary[], health: AgentHealth[]): AgentGridItem[] {
  const healthByName = new Map(health.map((h) => [h.name, h]))
  const agentByName = new Map(agents.map((a) => [a.name, a]))
  const items: AgentGridItem[] = []
  const seen = new Set<string>()

  const push = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    const a = agentByName.get(name)
    const h = healthByName.get(name)
    const status = h
      ? liveStatusFromHealth(h.status)
      : a?.running
        ? 'unknown'
        : 'offline'
    items.push({
      name,
      displayName: a?.displayName || name,
      status,
      lastActiveTs: h?.lastProgressTs ?? null,
      hasAvatar: a?.hasAvatar ?? false,
      isMain: h?.isMain ?? false,
    })
  }

  const main = health.find((h) => h.isMain)
  if (main) push(main.name)
  for (const a of agents) push(a.name)

  return items
}
