import { cn } from '@/lib/cn'
import { WORK_STATUS_DOT, WORK_STATUS_LABEL } from '@/lib/status'
import type { AgentWorkStatus } from '@/types/api'

/**
 * Corner KOR dot: Boss-spec 5-state work-status indicator (card 8c823cdc).
 * Rendered absolutely in the top-right corner of an agent card.
 * WORKING pulses via animate-blink (CSS keyframe, reduced-motion: static ring).
 * Tooltip = status_reason from the poller (non-null, contains stale-caveat when
 * token_data_fresh=false so the stale-guard is visible to the user).
 */
export function WorkStatusKor({
  status,
  reason,
}: {
  status: AgentWorkStatus
  reason?: string
}) {
  const tooltip = reason ?? WORK_STATUS_LABEL[status]
  return (
    <span
      role="img"
      aria-label={WORK_STATUS_LABEL[status]}
      title={tooltip}
      className={cn(
        'absolute right-2 top-2 h-2.5 w-2.5 rounded-full ring-1 ring-black/20',
        WORK_STATUS_DOT[status],
      )}
    />
  )
}
