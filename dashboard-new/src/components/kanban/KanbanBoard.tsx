import { useState } from 'react'
import { KanbanColumn } from './KanbanColumn'
import { KanbanProjectColumn } from './KanbanProjectColumn'
import { CardDrawer } from './CardDrawer'
import { groupCardsByStatus, groupCardsByProject, getStaleCards, isCardStale, cardAgeSeconds, formatAge } from '@/lib/kanban'
import { KANBAN_COLUMNS } from '@/lib/status'
import { cn } from '@/lib/cn'
import { agentDisplayName } from '@/lib/display-name'
import type { KanbanCard } from '@/types/api'

type GroupBy = 'status' | 'project'

const GROUP_MODES: ReadonlyArray<{ key: GroupBy; label: string }> = [
  { key: 'status', label: 'Statusz' },
  { key: 'project', label: 'Projekt' },
]

/** Compact row in the stale-cards alert panel (card 31f24bad). */
function StaleRow({ card, nowSec, onSelect }: { card: KanbanCard; nowSec: number; onSelect: (c: KanbanCard) => void }) {
  const ageSec = cardAgeSeconds(card, nowSec)
  const stale = isCardStale(card, nowSec)
  return (
    <button
      type="button"
      onClick={() => onSelect(card)}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-bg-elevated"
    >
      <span
        className={cn(
          'w-6 shrink-0 font-mono tabular-nums',
          stale === true ? 'text-red-400' : 'text-yellow-500/70',
        )}
      >
        {formatAge(ageSec)}
      </span>
      <span className="truncate text-text">{card.title}</span>
      {card.code && (
        <span className="shrink-0 font-mono text-[10px] text-text-muted">{card.code}</span>
      )}
      <span className="shrink-0 text-text-muted">{agentDisplayName(card.assignee) ?? '-'}</span>
    </button>
  )
}

/**
 * Read-only kanban board (AC-F0-7..9). Groups by status (four columns) by default,
 * or by the canonical project taxonomy (card cf0d1bfe S3) via the group-by toggle.
 * Horizontally scrollable on mobile.
 * Card 31f24bad: aging badge on each chip + stale-alert panel above the board.
 */
export function KanbanBoard({ cards }: { cards: KanbanCard[] }) {
  const [selected, setSelected] = useState<KanbanCard | null>(null)
  const [groupBy, setGroupBy] = useState<GroupBy>('status')
  const [staleOpen, setStaleOpen] = useState(true)

  const nowSec = Math.floor(Date.now() / 1000)
  const statusGroups = groupCardsByStatus(cards)
  const projectGroups = groupCardsByProject(cards)
  const staleCards = getStaleCards(cards, nowSec)

  return (
    <>
      {/* Stale-alert panel (card 31f24bad): visible when any active card is stale/unknown. */}
      {staleCards.length > 0 && (
        <div className="mb-3 rounded-lg border border-red-500/30 bg-red-950/10">
          <button
            type="button"
            onClick={() => setStaleOpen((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-left"
          >
            <span className="text-xs font-semibold text-red-400">
              Beragadt kartya ({staleCards.length})
            </span>
            <span className="text-[10px] text-text-muted">{staleOpen ? '▲' : '▼'}</span>
          </button>
          {staleOpen && (
            <div className="border-t border-red-500/20 px-1 pb-1">
              {staleCards.map((c) => (
                <StaleRow key={c.id} card={c} nowSec={nowSec} onSelect={setSelected} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mb-3 flex items-center gap-1" role="group" aria-label="Csoportositas">
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
              <KanbanColumn key={status} status={status} cards={statusGroups[status]} onSelect={setSelected} nowSec={nowSec} />
            ))
          : projectGroups.map((group) => (
              <KanbanProjectColumn
                key={group.project ?? '__other__'}
                project={group.project}
                cards={group.cards}
                onSelect={setSelected}
                nowSec={nowSec}
              />
            ))}
      </div>
      <CardDrawer card={selected} onClose={() => setSelected(null)} />
    </>
  )
}
