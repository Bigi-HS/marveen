import { useEffect, useState } from 'react'
import { fetchFleetAgents, fetchKanbanOpen } from '@/lib/api-app'
import { Skeleton } from '@/components/Skeleton'
import { cn } from '@/lib/cn'
import type { AgentSummary, KanbanCardSummary } from '@/lib/api-app'

const STATUS_LABELS: Record<string, string> = {
  in_progress: 'Folyamatban',
  planned: 'Tervezett',
  waiting: 'Várakozik',
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'text-red-400',
  high: 'text-orange-400',
  normal: 'text-text-muted',
  low: 'text-text-muted opacity-60',
}

function AgentCard({ agent }: { agent: AgentSummary }) {
  const initials = agent.displayName.slice(0, 2).toUpperCase()
  return (
    <div className="surface-card flex items-center gap-3 rounded-xl border border-border p-3">
      <div className="relative shrink-0">
        {agent.hasAvatar ? (
          <img
            src={`/api/agents/${encodeURIComponent(agent.name)}/avatar`}
            alt={agent.displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/20 text-sm font-semibold text-accent">
            {initials}
          </div>
        )}
        <span
          data-testid={agent.running ? `agent-running-${agent.name}` : `agent-stopped-${agent.name}`}
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-bg',
            agent.running ? 'bg-green-400' : 'bg-zinc-500',
          )}
          title={agent.running ? 'Fut' : 'Leállítva'}
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text">{agent.displayName}</p>
        <p className="truncate text-xs text-text-muted">{agent.model.replace('claude-', '').replace('-[1m]', ' 1M')}</p>
      </div>
      {agent.running && agent.contextPercent != null && (
        <span className="shrink-0 rounded-md bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
          {agent.contextPercent}%
        </span>
      )}
    </div>
  )
}

function KanbanSnapshot({ cards }: { cards: KanbanCardSummary[] }) {
  const inProgress = cards.filter((c) => c.status === 'in_progress')

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        {(['in_progress', 'planned', 'waiting'] as const).map((s) => {
          const count = cards.filter((c) => c.status === s).length
          return (
            <div
              key={s}
              data-testid={`kanban-${s}-count`}
              className="flex-1 rounded-xl border border-border p-2 text-center"
            >
              <p className="text-lg font-bold text-text">{count}</p>
              <p className="text-xs text-text-muted">{STATUS_LABELS[s]}</p>
            </div>
          )
        })}
      </div>

      {inProgress.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Aktív kártyák</p>
          {inProgress.slice(0, 5).map((card) => (
            <div
              key={card.id}
              className="surface-card flex items-center gap-2 rounded-lg border border-border px-3 py-2"
            >
              {card.code && (
                <span className="shrink-0 font-mono text-xs text-text-muted">{card.code}</span>
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-text">{card.title}</span>
              {card.priority !== 'normal' && (
                <span className={cn('shrink-0 text-xs', PRIORITY_COLORS[card.priority] ?? 'text-text-muted')}>
                  {card.priority}
                </span>
              )}
            </div>
          ))}
          {inProgress.length > 5 && (
            <p className="text-xs text-text-muted">+{inProgress.length - 5} további</p>
          )}
        </div>
      )}
    </div>
  )
}

export function FlottaScreen() {
  const [agents, setAgents] = useState<AgentSummary[] | undefined>(undefined)
  const [cards, setCards] = useState<KanbanCardSummary[] | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([fetchFleetAgents(), fetchKanbanOpen()])
      .then(([a, k]) => {
        setAgents(a)
        setCards(k)
      })
      .catch((err) => {
        setError((err as Error).message ?? 'Ismeretlen hiba')
        setAgents([])
        setCards([])
      })
  }, [])

  const loading = agents === undefined && error === null

  if (loading) {
    return (
      <div data-testid="fleet-loading" className="space-y-4">
        <Skeleton className="h-6 w-32 rounded" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-900/40 bg-red-950/20 p-4 text-sm text-red-400">
        Hiba: {error}
      </div>
    )
  }

  const agentList = agents ?? []
  const cardList = cards ?? []

  return (
    <div className="space-y-5">
      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Flotta ({agentList.length} ágens)
        </p>
        {agentList.length === 0 ? (
          <p className="text-sm text-text-muted">Nincs ágens konfigurálva.</p>
        ) : (
          <div className="space-y-2">
            {agentList.map((agent) => (
              <AgentCard key={agent.name} agent={agent} />
            ))}
          </div>
        )}
      </section>

      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Kanban ({cardList.length} nyitott kártya)
        </p>
        <KanbanSnapshot cards={cardList} />
      </section>
    </div>
  )
}
