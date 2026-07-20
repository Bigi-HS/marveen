import { cn } from '@/lib/cn'
import { relativeTime, secToMs, truncate } from '@/lib/format'
import { EmptyState } from '@/components/EmptyState'
import type { ToolCallEvent } from '@/types/api'

// Card 229a9000 (agent-flow event-relay steal): the live hook-event stream. The
// backend relays each PostToolUse tool call onto the SSE bus; this list renders
// the recent window newest-first, refreshed on every 'hook-event' revision. A
// list idiom (not agent-flow's node graph) to fit the existing dashboard; the
// palette avoids red, so a failed call reads as an orange dot + label, not red.

/** Presentational: pure render of a recent tool-call window. */
export function HookStream({ events, nowMs }: { events: ToolCallEvent[]; nowMs: number }) {
  if (events.length === 0) {
    return <EmptyState message="Nincs friss hook-esemeny. Kapcsold be a tool-log relay hookot a streameleshez." />
  }

  const rows = [...events].sort((a, b) => b.created_at - a.created_at)

  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((e) => {
        const ok = e.success !== 0
        return (
          <li
            key={e.id}
            className="flex items-center gap-3 rounded-lg border border-border bg-bg-surface px-3 py-2"
          >
            <span
              role="img"
              aria-label={ok ? 'success' : 'failed'}
              title={ok ? 'success' : 'failed'}
              className={cn(
                'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
                ok ? 'bg-status-done' : 'bg-status-waiting',
              )}
            />
            <span className="shrink-0 font-mono text-sm text-primary">{e.tool_name}</span>
            {e.input_summary && (
              <span className="min-w-0 flex-1 truncate text-sm text-text-muted">
                {truncate(e.input_summary, 120)}
              </span>
            )}
            <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">
              {e.session_id.slice(0, 8)}
            </span>
            <span className="shrink-0 text-xs text-text-muted">
              {relativeTime(secToMs(e.created_at), nowMs)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
