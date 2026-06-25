import { AlertTriangle } from 'lucide-react'
import { StatusDot } from './StatusDot'
import { PriorityBadge } from './PriorityBadge'
import { EmptyState } from './EmptyState'
import { selectNeedsAttention, needsAttentionEmpty } from '@/lib/needs-attention'
import { truncate } from '@/lib/format'
import type { AgentGridItem, KanbanCard } from '@/types/api'

/** "Needs attention" block (AC-F0-5): stalled/offline agents + urgent/high open cards. */
export function NeedsAttentionBlock({ agents, cards }: { agents: AgentGridItem[]; cards: KanbanCard[] }) {
  const na = selectNeedsAttention(agents, cards)

  return (
    <section className="rounded-lg border border-border bg-bg-surface p-4">
      <header className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
        <AlertTriangle className="h-4 w-4 text-primary" />
        Needs attention
      </header>

      {needsAttentionEmpty(na) ? (
        <EmptyState message="All clear -- nothing needs attention." />
      ) : (
        <div className="space-y-3">
          {na.agents.length > 0 && (
            <ul className="space-y-1.5">
              {na.agents.map((a) => (
                <li key={a.name} className="flex items-center gap-2 text-sm text-text">
                  <StatusDot status={a.status} />
                  <span className="font-medium">{a.displayName}</span>
                  <span className="text-xs text-text-muted">{a.status}</span>
                </li>
              ))}
            </ul>
          )}
          {na.cards.length > 0 && (
            <ul className="space-y-1.5">
              {na.cards.map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-sm text-text">
                  <PriorityBadge priority={c.priority} />
                  <span className="min-w-0 flex-1 truncate">{truncate(c.title, 60)}</span>
                  <span className="text-xs text-text-muted">{c.assignee ?? 'unassigned'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
