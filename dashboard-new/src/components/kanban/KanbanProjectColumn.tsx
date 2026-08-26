import { KanbanCardChip } from './KanbanCardChip'
import { EmptyState } from '../EmptyState'
import { PROJECT_GROUP_OTHER_LABEL } from '@/lib/project'
import type { KanbanCard } from '@/types/api'

/**
 * One project swimlane (card cf0d1bfe S3): header with the canonical prefix (or the
 * "Egyéb" bucket for null/non-canonical), a card count, then the card chips. Mirrors
 * KanbanColumn but keyed on project instead of status. Read-only.
 */
export function KanbanProjectColumn({
  project,
  cards,
  onSelect,
  nowSec,
}: {
  project: string | null
  cards: KanbanCard[]
  onSelect: (card: KanbanCard) => void
  nowSec: number
}) {
  const label = project ?? PROJECT_GROUP_OTHER_LABEL
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-bg-surface">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="font-mono text-sm font-semibold tracking-wide text-accent">{label}</span>
        <span className="rounded bg-bg-elevated px-1.5 py-0.5 font-mono text-xs tabular-nums text-text-muted">{cards.length}</span>
      </header>
      <div className="flex flex-col gap-2 p-2">
        {cards.length === 0 ? (
          <EmptyState message="Üres" compact />
        ) : (
          cards.map((c) => <KanbanCardChip key={c.id} card={c} onClick={() => onSelect(c)} nowSec={nowSec} />)
        )}
      </div>
    </div>
  )
}
