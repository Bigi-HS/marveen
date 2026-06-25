import { cn } from '@/lib/cn'
import { AGENT_STATUS_DOT, AGENT_STATUS_LABEL } from '@/lib/status'
import type { AgentLiveStatus } from '@/types/api'

/** Agent status indicator dot (AC-F0-4). Busy pulses to read as "live". */
export function StatusDot({ status }: { status: AgentLiveStatus }) {
  return (
    <span
      role="img"
      aria-label={AGENT_STATUS_LABEL[status]}
      title={AGENT_STATUS_LABEL[status]}
      className={cn(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
        AGENT_STATUS_DOT[status],
        status === 'busy' && 'animate-pulse',
      )}
    />
  )
}
