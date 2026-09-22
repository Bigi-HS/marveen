import { PriorityBadge } from '../PriorityBadge'
import { truncate } from '@/lib/format'
import { agentDisplayName } from '@/lib/display-name'
import { cardAgeSeconds, isCardStale, formatAge } from '@/lib/kanban'
import { cn } from '@/lib/cn'
import type { KanbanCard } from '@/types/api'

/** A single kanban card chip (AC-F0-8). Click opens the read-only detail drawer. */
export function KanbanCardChip({ card, onClick, nowSec }: { card: KanbanCard; onClick: () => void; nowSec?: number }) {
  const now = nowSec ?? Math.floor(Date.now() / 1000)
  const ageSec = cardAgeSeconds(card, now)
  const stale = isCardStale(card, now)
  const ageLabel = formatAge(ageSec)
  // fc574fb3: intentionally-parked and boss-gated cards get amber border, not red.
  const isParked = card.parked_until != null && card.parked_until > now
  const isBossWaiting = Boolean(card.boss_waiting)

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border p-2.5 text-left transition-colors focus:outline-none focus:ring-1 focus:ring-accent',
        stale === true
          ? 'border-red-500/40 bg-red-950/20 hover:border-red-500/60'
          : isParked || isBossWaiting
            ? 'border-amber-500/30 bg-amber-950/10 hover:border-amber-500/50'
            : 'border-border bg-bg-elevated hover:border-accent/50',
      )}
    >
      {/* The immutable taxonomy code is the Boss-facing reference id (cf0d1bfe);
          surface it so a card can be cited by code, not raw hex. */}
      {card.code && (
        <div className="mb-1 font-mono text-[10px] tabular-nums tracking-wide text-text-muted">{card.code}</div>
      )}
      <div className="text-sm text-text">{truncate(card.title, 60)}</div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-xs text-text-muted">{agentDisplayName(card.assignee) ?? 'kiosztatlan'}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Parked/boss-waiting badge: amber, not the stale-red signal. */}
          {isParked && <span className="text-[10px] text-amber-400/80">⏸ park</span>}
          {!isParked && isBossWaiting && <span className="text-[10px] text-amber-400/80">boss-gate</span>}
          {/* Age badge: red when stale, yellow when unmeasured, muted otherwise. */}
          <span
            className={cn(
              'font-mono text-[10px] tabular-nums',
              stale === true ? 'text-red-400' : stale === 'unknown' ? 'text-yellow-500/70' : 'text-text-muted',
            )}
          >
            {ageLabel}
          </span>
          {/* "Normál" on every card is noise; only non-default priorities earn a badge. */}
          {card.priority !== 'normal' && <PriorityBadge priority={card.priority} />}
        </div>
      </div>
    </button>
  )
}
