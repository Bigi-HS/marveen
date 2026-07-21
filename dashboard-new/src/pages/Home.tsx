import { usePolling } from '@/hooks/usePolling'
import { useEventStream } from '@/hooks/useEventStream'
import { mergeAgentStatus } from '@/lib/agent-grid'
import { isAuthError } from '@/lib/auth-error'
import { AgentGrid } from '@/components/AgentGrid'
import { StatBar } from '@/components/StatBar'
import { NeedsAttentionBlock } from '@/components/NeedsAttentionBlock'
import { ActivityFeed } from '@/components/ActivityFeed'
import { AuthRequired } from '@/components/AuthRequired'
import { Skeleton } from '@/components/Skeleton'
import type { AgentSummary, AgentHealth, KanbanCard, AgentMessage } from '@/types/api'

function SectionTitle({ children }: { children: string }) {
  return <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-muted">{children}</h2>
}

export function Home() {
  // Realtime (cards 513b8fd6 F1 + edf73bd7 F2): SSE revisions drive immediate
  // refetch; each poll keeps a slow safety backstop. F2 added an agent-status
  // push (server-side pane-diff watcher) so the fleet grid now refetches on a
  // stabilised activity transition instead of a 5s poll; kanban/message refresh
  // on their own SSE revision.
  const { revisions } = useEventStream()
  const agents = usePolling<AgentSummary[]>('/api/agents', { refreshSignal: revisions['agent-status'], intervalMs: 30000 })
  const health = usePolling<AgentHealth[]>('/api/agents/health', { refreshSignal: revisions['agent-status'], intervalMs: 30000 })
  const kanban = usePolling<KanbanCard[]>('/api/kanban', { refreshSignal: revisions.kanban + revisions.board })
  const messages = usePolling<AgentMessage[]>('/api/messages?limit=5', { refreshSignal: revisions.message })

  if ([agents, health, kanban, messages].some((s) => isAuthError(s.error))) {
    return <AuthRequired />
  }

  const nowMs = Date.now()
  const grid = mergeAgentStatus(agents.data ?? [], health.data ?? [])
  const cards = kanban.data ?? []
  const loadingGrid = agents.loading && health.loading && grid.length === 0

  return (
    <div className="space-y-6">
      {loadingGrid ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[68px]" />
          ))}
        </div>
      ) : (
        <StatBar agents={grid} cards={cards} />
      )}

      {/* No SectionTitle here: the block carries its own "Figyelmet kér" header,
          the doubled title read as a stutter. */}
      <section>
        <NeedsAttentionBlock agents={grid} cards={cards} />
      </section>

      <section>
        <SectionTitle>Flotta</SectionTitle>
        {loadingGrid ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : (
          <AgentGrid agents={grid} nowMs={nowMs} />
        )}
      </section>

      <section>
        <SectionTitle>Friss aktivitás</SectionTitle>
        {messages.loading && !messages.data ? (
          <Skeleton className="h-32" />
        ) : (
          <ActivityFeed messages={messages.data ?? []} nowMs={nowMs} />
        )}
      </section>
    </div>
  )
}
