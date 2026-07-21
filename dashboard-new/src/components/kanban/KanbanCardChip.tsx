import { PriorityBadge } from '../PriorityBadge'
import { truncate } from '@/lib/format'
import { agentDisplayName } from '@/lib/display-name'
import type { KanbanCard } from '@/types/api'

/** A single kanban card chip (AC-F0-8). Click opens the read-only detail drawer. */
export function KanbanCardChip({ card, onClick }: { card: KanbanCard; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-border bg-bg-elevated p-2.5 text-left transition-colors hover:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent"
    >
      <div className="text-sm text-text">{truncate(card.title, 60)}</div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-xs text-text-muted">{agentDisplayName(card.assignee) ?? 'kiosztatlan'}</span>
        {/* "Normál" on every card is noise; only non-default priorities earn a badge. */}
        {card.priority !== 'normal' && <PriorityBadge priority={card.priority} />}
      </div>
    </button>
  )
}
