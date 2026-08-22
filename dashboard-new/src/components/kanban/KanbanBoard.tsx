import { useState } from 'react'
import { KanbanColumn } from './KanbanColumn'
import { KanbanProjectColumn } from './KanbanProjectColumn'
import { CardDrawer } from './CardDrawer'
import { groupCardsByStatus, groupCardsByProject } from '@/lib/kanban'
import { KANBAN_COLUMNS } from '@/lib/status'
import { cn } from '@/lib/cn'
import type { KanbanCard } from '@/types/api'

type GroupBy = 'status' | 'project'

const GROUP_MODES: ReadonlyArray<{ key: GroupBy; label: string }> = [
  { key: 'status', label: 'Státusz' },
  { key: 'project', label: 'Projekt' },
]

/**
 * Read-only kanban board (AC-F0-7..9). Groups by status (four columns) by default,
 * or by the canonical project taxonomy (card cf0d1bfe S3) via the group-by toggle.
 * Horizontally scrollable on mobile.
 */
export function KanbanBoard({ cards }: { cards: KanbanCard[] }) {
  const [selected, setSelected] = useState<KanbanCard | null>(null)
  const [groupBy, setGroupBy] = useState<GroupBy>('status')

  const statusGroups = groupCardsByStatus(cards)
  const projectGroups = groupCardsByProject(cards)

  return (
    <>
      <div className="mb-3 flex items-center gap-1" role="group" aria-label="Csoportosítás">
        {GROUP_MODES.map((mode) => (
          <button
            key={mode.key}
            type="button"
            aria-pressed={groupBy === mode.key}
            onClick={() => setGroupBy(mode.key)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              groupBy === mode.key
                ? 'bg-bg-elevated text-text ring-1 ring-inset ring-border'
                : 'text-text-muted hover:text-text',
            )}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {groupBy === 'status'
          ? KANBAN_COLUMNS.map((status) => (
              <KanbanColumn key={status} status={status} cards={statusGroups[status]} onSelect={setSelected} />
            ))
          : projectGroups.map((group) => (
              <KanbanProjectColumn
                key={group.project ?? '__other__'}
                project={group.project}
                cards={group.cards}
                onSelect={setSelected}
              />
            ))}
      </div>
      <CardDrawer card={selected} onClose={() => setSelected(null)} />
    </>
  )
}
