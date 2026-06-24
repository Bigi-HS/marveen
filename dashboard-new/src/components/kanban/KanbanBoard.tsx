import { useState } from 'react'
import { KanbanColumn } from './KanbanColumn'
import { CardDrawer } from './CardDrawer'
import { groupCardsByStatus } from '@/lib/kanban'
import { KANBAN_COLUMNS } from '@/lib/status'
import type { KanbanCard } from '@/types/api'

/** Read-only kanban board (AC-F0-7..9): four columns, horizontally scrollable on mobile. */
export function KanbanBoard({ cards }: { cards: KanbanCard[] }) {
  const [selected, setSelected] = useState<KanbanCard | null>(null)
  const groups = groupCardsByStatus(cards)

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {KANBAN_COLUMNS.map((status) => (
          <KanbanColumn key={status} status={status} cards={groups[status]} onSelect={setSelected} />
        ))}
      </div>
      <CardDrawer card={selected} onClose={() => setSelected(null)} />
    </>
  )
}
