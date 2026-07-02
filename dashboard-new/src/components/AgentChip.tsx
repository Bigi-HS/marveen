import { cn } from '@/lib/cn'
import { relativeTime } from '@/lib/format'
import { AGENT_STATUS_CHIP, AGENT_STATUS_ACCENT, AGENT_STATUS_LABEL } from '@/lib/status'
import { StatusDot } from './StatusDot'
import { Avatar } from './Avatar'
import type { AgentGridItem } from '@/types/api'

/**
 * HOME agent card (AC-F0-3): avatar, name, status dot + readable status pill, and
 * last-active relative time. A left accent rail (before:) surfaces attention states
 * (stalled/offline) so the grid scans at a glance; hover lifts the card for depth.
 */
export function AgentChip({ agent, nowMs }: { agent: AgentGridItem; nowMs: number }) {
  return (
    <div
      className={cn(
        'group surface-card relative flex items-center gap-3 overflow-hidden rounded-xl border border-border p-3 pl-4',
        'transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-glow',
        // left accent rail (before:) -- colour comes from AGENT_STATUS_ACCENT
        'before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[""]',
        AGENT_STATUS_ACCENT[agent.status],
        agent.isMain && 'ring-1 ring-accent/40',
      )}
    >
      <Avatar
        name={agent.name}
        hasAvatar={agent.hasAvatar}
        className="h-10 w-10 transition-transform group-hover:scale-105"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold text-text">{agent.displayName}</span>
          {agent.isMain && (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
              you
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-text-muted">{relativeTime(agent.lastActiveTs, nowMs)}</div>
      </div>
      <span
        className={cn(
          'flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium',
          AGENT_STATUS_CHIP[agent.status],
        )}
      >
        <StatusDot status={agent.status} />
        {AGENT_STATUS_LABEL[agent.status]}
      </span>
    </div>
  )
}
