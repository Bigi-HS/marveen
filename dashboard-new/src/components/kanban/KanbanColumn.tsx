import { cn } from '@/lib/cn'
import { KANBAN_COLUMN_LABEL, KANBAN_COLUMN_ACCENT } from '@/lib/status'
import { KanbanCardChip } from './KanbanCardChip'
import { EmptyState } from '../EmptyState'
import type { KanbanCard, KanbanStatus } from '@/types/api'

/** One kanban column (AC-F0-7): header with count, then card chips or an empty state. */
export function KanbanColumn({
  status,
  cards,
  onSelect,
}: {
  status: KanbanStatus
  cards: KanbanCard[]
  onSelect: (card: KanbanCard) => void
}) {
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-bg-surface">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className={cn('text-sm font-semibold', KANBAN_COLUMN_ACCENT[status])}>
          {KANBAN_COLUMN_LABEL[status]}
        </span>
        <span className="rounded bg-bg-elevated px-1.5 py-0.5 font-mono text-xs tabular-nums text-text-muted">{cards.length}</span>
      </header>
      <div className="flex flex-col gap-2 p-2">
        {cards.length === 0 ? (
          <EmptyState message="Üres" compact />
        ) : (
          cards.map((c) => <KanbanCardChip key={c.id} card={c} onClick={() => onSelect(c)} />)
        )}
      </div>
    </div>
  )
}
