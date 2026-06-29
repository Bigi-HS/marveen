import { usePolling } from '@/hooks/usePolling'
import { useEventStream } from '@/hooks/useEventStream'
import { mergeAgentStatus } from '@/lib/agent-grid'
import { isAuthError } from '@/lib/auth-error'
import { AgentGrid } from '@/components/AgentGrid'
import { NeedsAttentionBlock } from '@/components/NeedsAttentionBlock'
import { ActivityFeed } from '@/components/ActivityFeed'
import { AuthRequired } from '@/components/AuthRequired'
import { Skeleton } from '@/components/Skeleton'
import type { AgentSummary, AgentHealth, KanbanCard, AgentMessage } from '@/types/api'

function SectionTitle({ children }: { children: string }) {
  return <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-muted">{children}</h2>
}

export function Home() {
  // F1 realtime (card 513b8fd6): SSE revisions drive immediate refetch; each
  // poll keeps a slow safety backstop. Agent status has no push event yet (it is
  // computed live per request) so it stays on a short poll; kanban/message
  // refresh on their SSE revision. The activity feed keeps its own short poll.
  const { revisions } = useEventStream()
  const agents = usePolling<AgentSummary[]>('/api/agents', { intervalMs: 5000 })
  const health = usePolling<AgentHealth[]>('/api/agents/health', { intervalMs: 5000 })
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
      <section>
        <SectionTitle>Needs attention</SectionTitle>
        <NeedsAttentionBlock agents={grid} cards={cards} />
      </section>

      <section>
        <SectionTitle>Fleet</SectionTitle>
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
        <SectionTitle>Latest activity</SectionTitle>
        {messages.loading && !messages.data ? (
          <Skeleton className="h-32" />
        ) : (
          <ActivityFeed messages={messages.data ?? []} nowMs={nowMs} />
        )}
      </section>
    </div>
  )
}
