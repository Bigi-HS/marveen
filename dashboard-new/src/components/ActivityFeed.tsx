import { ArrowRight } from 'lucide-react'
import { relativeTime, truncate, secToMs } from '@/lib/format'
import { agentDisplayName } from '@/lib/display-name'
import { EmptyState } from './EmptyState'
import type { AgentMessage } from '@/types/api'

/**
 * Latest activity feed (AC-F0-6): the five most recent inter-agent messages,
 * newest first, with from -> to agents, an 80-char preview, and a relative
 * timestamp. Rows hover-highlight so the live stream feels alive.
 */
export function ActivityFeed({ messages, nowMs }: { messages: AgentMessage[]; nowMs: number }) {
  const recent = [...messages].sort((a, b) => b.created_at - a.created_at).slice(0, 5)
  if (recent.length === 0) return <EmptyState message="Nincs friss aktivitás." />

  return (
    <ul className="surface-card divide-y divide-border overflow-hidden rounded-xl border border-border">
      {recent.map((m) => (
        <li key={m.id} className="px-4 py-2.5 transition-colors hover:bg-bg-elevated/40">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1 font-medium text-accent">
              {agentDisplayName(m.from_agent)}
              <ArrowRight className="h-3 w-3 text-text-muted" />
              <span className="text-text-muted">{agentDisplayName(m.to_agent)}</span>
            </span>
            <span className="shrink-0 text-text-muted">{relativeTime(secToMs(m.created_at), nowMs)}</span>
          </div>
          <p className="mt-1 text-sm text-text-muted">{truncate(m.content, 80)}</p>
        </li>
      ))}
    </ul>
  )
}
