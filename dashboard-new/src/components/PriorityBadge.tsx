import { cn } from '@/lib/cn'
import { PRIORITY_BADGE, PRIORITY_LABEL } from '@/lib/status'
import type { Priority } from '@/types/api'

/** Kanban priority badge (AC-F0-8), palette-token styled. */
export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
        PRIORITY_BADGE[priority],
      )}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  )
}
