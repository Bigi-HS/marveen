import { cn } from '@/lib/cn'
import { relativeTime } from '@/lib/format'
import { StatusDot } from './StatusDot'
import { Avatar } from './Avatar'
import type { AgentGridItem } from '@/types/api'

/** HOME agent card (AC-F0-3): avatar, name, status dot, last-active relative time. */
export function AgentChip({ agent, nowMs }: { agent: AgentGridItem; nowMs: number }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border bg-bg-surface p-3',
        agent.isMain && 'ring-1 ring-accent/40',
      )}
    >
      <Avatar name={agent.name} hasAvatar={agent.hasAvatar} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusDot status={agent.status} />
          <span className="truncate font-medium text-text">{agent.displayName}</span>
        </div>
        <div className="truncate text-xs text-text-muted">{relativeTime(agent.lastActiveTs, nowMs)}</div>
      </div>
    </div>
  )
}
