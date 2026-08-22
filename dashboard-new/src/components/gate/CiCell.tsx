import { cn } from '@/lib/cn'
import { CI_CHIP, CI_LABEL } from '@/lib/gate'
import type { GateCiStatus } from '@/types/gate'

/** CI status cell. When CI is not required and never ran it is simply not part of
 *  the gate ("N/A"); a required-but-absent run reads as "Wait". */
export function CiCell({ status, required }: { status: GateCiStatus; required: boolean }) {
  const label = status === 'none' ? (required ? 'CI pending' : 'CI not required') : CI_LABEL[status]
  const text = status === 'pass' ? 'Pass' : status === 'fail' ? 'Fail' : required ? 'Wait' : 'N/A'
  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
        CI_CHIP[status],
      )}
    >
      {text}
    </span>
  )
}
