import { PriorityBadge } from '../PriorityBadge'
import { truncate } from '@/lib/format'
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
        <span className="truncate text-xs text-text-muted">{card.assignee ?? 'unassigned'}</span>
        <PriorityBadge priority={card.priority} />
      </div>
    </button>
  )
}
