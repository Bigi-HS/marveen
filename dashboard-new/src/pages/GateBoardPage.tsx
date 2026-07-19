import { useEventStream } from '@/hooks/useEventStream'
import { usePolling } from '@/hooks/usePolling'
import { isAuthError } from '@/lib/auth-error'
import { AuthRequired } from '@/components/AuthRequired'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { GateBoard } from '@/components/gate/GateBoard'
import type { GateBoard as GateBoardData } from '@/types/gate'

/** Gate Board page (card 87c32aa4). Live-refreshed via the SSE 'gate' revision
 *  (approve/block/override bumps it); the 30s poll is a backstop. Read-only. */
export function GateBoardPage() {
  const { revisions } = useEventStream()
  const board = usePolling<GateBoardData>('/api/gate/board', { refreshSignal: revisions.gate })

  if (isAuthError(board.error)) return <AuthRequired />

  if (board.loading && !board.data) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    )
  }

  if (board.error && !board.data) {
    return <EmptyState message="A gate board most nem elérhető." />
  }

  return <GateBoard prs={board.data?.prs ?? []} nowMs={Date.now()} />
}
