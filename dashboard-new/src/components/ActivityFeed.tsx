import { relativeTime, truncate, secToMs } from '@/lib/format'
import { EmptyState } from './EmptyState'
import type { AgentMessage } from '@/types/api'

/**
 * Latest activity feed (AC-F0-6): the five most recent inter-agent messages,
 * newest first, with from-agent, an 80-char preview, and a relative timestamp.
 */
export function ActivityFeed({ messages, nowMs }: { messages: AgentMessage[]; nowMs: number }) {
  const recent = [...messages].sort((a, b) => b.created_at - a.created_at).slice(0, 5)
  if (recent.length === 0) return <EmptyState message="No recent activity." />

  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-bg-surface">
      {recent.map((m) => (
        <li key={m.id} className="px-3 py-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium text-accent">
              {m.from_agent} <span className="text-text-muted">-&gt; {m.to_agent}</span>
            </span>
            <span className="shrink-0 text-text-muted">{relativeTime(secToMs(m.created_at), nowMs)}</span>
          </div>
          <p className="mt-0.5 text-sm text-text-muted">{truncate(m.content, 80)}</p>
        </li>
      ))}
    </ul>
  )
}
