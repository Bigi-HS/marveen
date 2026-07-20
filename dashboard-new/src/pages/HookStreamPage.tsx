import { useEventStream } from '@/hooks/useEventStream'
import { usePolling } from '@/hooks/usePolling'
import { isAuthError } from '@/lib/auth-error'
import { AuthRequired } from '@/components/AuthRequired'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { HookStream } from '@/components/HookStream'
import type { ToolCallEvent } from '@/types/api'

// Card 229a9000 (agent-flow event-relay steal). Live-refreshed via the SSE
// 'hook-event' revision (the backend relays each tool-log POST); the 30s poll is
// the backstop. Read-only: the data comes through the authed GET /api/tool-log.
const WINDOW_SECS = 1800

export function HookStreamPage() {
  const { revisions } = useEventStream()
  const log = usePolling<ToolCallEvent[]>(`/api/tool-log?since=${WINDOW_SECS}`, {
    refreshSignal: revisions['hook-event'],
  })

  if (isAuthError(log.error)) return <AuthRequired />

  if (log.loading && !log.data) {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (log.error && !log.data) {
    return <EmptyState message="A hook-event stream most nem elérhető." />
  }

  return <HookStream events={log.data ?? []} nowMs={Date.now()} />
}
