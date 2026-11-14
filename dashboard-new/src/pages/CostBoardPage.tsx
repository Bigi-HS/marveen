import { usePolling } from '@/hooks/usePolling'
import { isAuthError } from '@/lib/auth-error'
import { AuthRequired } from '@/components/AuthRequired'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { CostBoard } from '@/components/cost/CostBoard'
import type { CostBoard as CostBoardData } from '@/types/cost'

/** Cost board page (card e230c097 slice 2). Read-only per-agent spend over
 *  GET /api/token-usage/cost. No SSE signal carries token usage, so this uses the
 *  plain 30s backstop poll (the collector ingests transcripts on its own cadence). */
export function CostBoardPage() {
  const board = usePolling<CostBoardData>('/api/token-usage/cost')

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
    return <EmptyState message="A költség-board most nem elérhető." />
  }

  const data = board.data ?? { agents: [], lineage: [], unrated: [] }
  return <CostBoard board={data} nowMs={Date.now()} />
}
