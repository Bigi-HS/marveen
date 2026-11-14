import { usePolling } from '@/hooks/usePolling'
import { isAuthError } from '@/lib/auth-error'
import { AuthRequired } from '@/components/AuthRequired'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { CostBoard } from '@/components/cost/CostBoard'
import { SpendTimeline } from '@/components/cost/SpendTimeline'
import type { CostBoard as CostBoardData, TimelineBucket } from '@/types/cost'

const BUCKET_MINUTES = 60
const WINDOW_HOURS = 24

/** Factory board page (card e230c097 slice 2). Read-only token-factory observability
 *  over the EXISTING token-usage endpoints: the per-agent spend board + burn-rate
 *  (GET /api/token-usage/cost) and a spend-over-time idősor (GET /api/token-usage/timeline).
 *  No SSE signal carries token usage, so this uses the plain 30s backstop poll (the
 *  collector ingests transcripts on its own cadence). The `from` is floored to the
 *  current hour so the timeline URL stays stable between polls within the hour. */
export function FactoryPage() {
  const board = usePolling<CostBoardData>('/api/token-usage/cost')
  const hourStartSec = Math.floor(Date.now() / 1000 / 3600) * 3600
  const fromSec = hourStartSec - WINDOW_HOURS * 3600
  const timeline = usePolling<TimelineBucket[]>(
    `/api/token-usage/timeline?bucket=${BUCKET_MINUTES}&from=${fromSec}`,
  )

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
    return <EmptyState message="A Factory board most nem elérhető." />
  }

  const data = board.data ?? { agents: [], lineage: [], unrated: [] }
  return (
    <div className="space-y-6">
      <CostBoard board={data} nowMs={Date.now()} />
      <SpendTimeline buckets={timeline.data ?? []} bucketMinutes={BUCKET_MINUTES} />
    </div>
  )
}
