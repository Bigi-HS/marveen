import { cn } from '@/lib/cn'
import { MERGE_CHIP, MERGE_LABEL, mergeState } from '@/lib/gate'
import type { GateBoardPr } from '@/types/gate'

/** Merge-readiness badge. NON-AUTHORITATIVE by design (the merge path re-checks):
 *  only a fully-verified PR earns the solid-green "Merge ready"; override and
 *  Chad-unverified states render distinctly so they can never read as a confident
 *  go at a glance (marveen guard). */
export function MergeBadge({ pr }: { pr: GateBoardPr }) {
  const state = mergeState(pr)
  return (
    <span
      aria-label={MERGE_LABEL[state]}
      title={MERGE_LABEL[state]}
      className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium', MERGE_CHIP[state])}
    >
      {MERGE_LABEL[state]}
    </span>
  )
}
