import { usePolling } from '@/hooks/usePolling'
import { useEventStream } from '@/hooks/useEventStream'
import { isAuthError } from '@/lib/auth-error'
import { KanbanBoard } from '@/components/kanban/KanbanBoard'
import { AuthRequired } from '@/components/AuthRequired'
import { Skeleton } from '@/components/Skeleton'
import type { KanbanCard } from '@/types/api'

export function KanbanPage() {
  // F1 realtime (card 513b8fd6): refetch the board on each kanban/board SSE
  // revision; the 30s default poll is the safety backstop.
  const { revisions } = useEventStream()
  const kanban = usePolling<KanbanCard[]>('/api/kanban', { refreshSignal: revisions.kanban + revisions.board })

  if (isAuthError(kanban.error)) return <AuthRequired />
  if (kanban.loading && !kanban.data) {
    return (
      <div className="flex gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-64 w-72 shrink-0" />
        ))}
      </div>
    )
  }

  return <KanbanBoard cards={kanban.data ?? []} />
}
