import { cn } from '@/lib/cn'

/**
 * Empty-state placeholder. The default is a prominent dashed panel for page-level
 * emptiness (e.g. "no PRs on the gate"). `compact` is the quiet variant for an empty
 * slot inside a denser layout -- a kanban column with no cards should not out-weigh
 * the populated columns next to it, so it drops the box and stays a faint caption.
 */
export function EmptyState({ message, compact = false }: { message: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-lg text-center text-text-muted',
        compact
          ? 'px-3 py-3 text-xs text-text-muted/70'
          : 'border border-dashed border-border px-4 py-6 text-sm',
      )}
    >
      {message}
    </div>
  )
}
