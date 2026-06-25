import { AgentChip } from './AgentChip'
import { EmptyState } from './EmptyState'
import type { AgentGridItem } from '@/types/api'

/**
 * Agent grid (AC-F0-3): single column < 768px, multi-column grid at >= 768px.
 * Empty roster -> explicit empty state (section 7), grid not rendered.
 */
export function AgentGrid({ agents, nowMs }: { agents: AgentGridItem[]; nowMs: number }) {
  if (agents.length === 0) return <EmptyState message="No agents found" />
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {agents.map((a) => (
        <AgentChip key={a.name} agent={a} nowMs={nowMs} />
      ))}
    </div>
  )
}
