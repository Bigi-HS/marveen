import { Users, Zap, AlertTriangle, KanbanSquare } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/cn'
import { agentNeedsAttention } from '@/lib/status'
import type { AgentGridItem, KanbanCard } from '@/types/api'

interface Stat {
  label: string
  value: number
  sub: string
  icon: ComponentType<{ className?: string }>
  tone: 'accent' | 'primary' | 'neutral'
}

const TONE: Record<Stat['tone'], { text: string; ring: string; bg: string }> = {
  accent: { text: 'text-accent', ring: 'ring-accent/25', bg: 'bg-accent/10' },
  primary: { text: 'text-primary', ring: 'ring-primary/30', bg: 'bg-primary/10' },
  neutral: { text: 'text-text', ring: 'ring-border', bg: 'bg-bg-elevated/60' },
}

/**
 * Fleet KPI bar (top of Mission Control): the whole picture in one glance --
 * fleet size, how many are working right now, how many need a look, and the
 * open-card load. Counts are derived, palette-token styled (INV-3).
 */
export function StatBar({ agents, cards }: { agents: AgentGridItem[]; cards: KanbanCard[] }) {
  const online = agents.filter((a) => a.status === 'idle' || a.status === 'busy').length
  const working = agents.filter((a) => a.status === 'busy').length
  const attention = agents.filter((a) => agentNeedsAttention(a.status)).length
  const openCards = cards.filter(
    (c) => c.status === 'planned' || c.status === 'in_progress' || c.status === 'waiting',
  ).length

  const stats: Stat[] = [
    { label: 'Flotta online', value: online, sub: `/ ${agents.length}`, icon: Users, tone: 'accent' },
    { label: 'Épp dolgozik', value: working, sub: 'aktív', icon: Zap, tone: 'primary' },
    { label: 'Figyelmet kér', value: attention, sub: 'beragadt / offline', icon: AlertTriangle, tone: attention > 0 ? 'primary' : 'neutral' },
    { label: 'Nyitott kártya', value: openCards, sub: 'a táblán', icon: KanbanSquare, tone: 'neutral' },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((s) => {
        const tone = TONE[s.tone]
        const Icon = s.icon
        return (
          <div
            key={s.label}
            className="surface-card flex items-center gap-3 rounded-xl border border-border p-3"
          >
            <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset', tone.bg, tone.ring)}>
              <Icon className={cn('h-5 w-5', tone.text)} />
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className={cn('text-[1.75rem] font-semibold leading-none tabular-nums', tone.text)}>{s.value}</span>
                <span className="text-xs text-text-muted">{s.sub}</span>
              </div>
              <div className="mt-1.5 truncate text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">{s.label}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
