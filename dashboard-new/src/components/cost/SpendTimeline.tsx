import { secToMs } from '@/lib/format'
import { formatTokens, formatUsd, totalsByBucket } from '@/lib/cost'
import { EmptyState } from '../EmptyState'
import type { TimelineBucket } from '@/types/cost'

/** Spend-over-time (idősor) for the Factory board (card e230c097 slice 2). A
 *  lightweight CSS bar chart of cost per time bucket, summed across agents, over
 *  GET /api/token-usage/timeline. No chart library -- bar heights are max-normalized
 *  so the shape of the burn is readable at a glance; each bar carries a title with
 *  the bucket time, cost, and token traffic. */
export function SpendTimeline({ buckets, bucketMinutes }: { buckets: TimelineBucket[]; bucketMinutes: number }) {
  const totals = totalsByBucket(buckets)

  if (totals.length === 0) {
    return <EmptyState message="Nincs idősor-adat a kiválasztott időablakban." />
  }

  const max = Math.max(...totals.map((t) => t.costUsd))
  const windowTotal = totals.reduce((sum, t) => sum + t.costUsd, 0)

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          Idősor <span className="font-normal normal-case text-text-muted">({bucketMinutes} perces vödrök)</span>
        </h3>
        <span className="text-sm font-medium tabular-nums text-text">{formatUsd(windowTotal)}</span>
      </div>
      <div
        data-testid="timeline-bars"
        role="img"
        aria-label="Költség idősor vödrönként"
        className="flex h-28 items-end gap-0.5"
      >
        {totals.map((t) => {
          const pct = max > 0 ? Math.round((t.costUsd / max) * 100) : 0
          const when = new Date(secToMs(t.bucket)).toLocaleString('hu-HU', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
          return (
            <div
              key={t.bucket}
              title={`${when}: ${formatUsd(t.costUsd)} / ${formatTokens(t.tokens)} token / ${t.calls} hívás`}
              className="flex-1"
            >
              <div
                className="w-full rounded-t bg-accent/70"
                style={{ height: `${Math.max(pct, 2)}%` }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
