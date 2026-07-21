import { AlertTriangle, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/cn'
import { StatusDot } from './StatusDot'
import { PriorityBadge } from './PriorityBadge'
import { selectNeedsAttention, needsAttentionEmpty } from '@/lib/needs-attention'
import { AGENT_STATUS_LABEL } from '@/lib/status'
import { truncate } from '@/lib/format'
import { agentDisplayName } from '@/lib/display-name'
import type { AgentGridItem, KanbanCard } from '@/types/api'

/** "Needs attention" block (AC-F0-5): stalled/offline agents + urgent/high open cards. */
export function NeedsAttentionBlock({ agents, cards }: { agents: AgentGridItem[]; cards: KanbanCard[] }) {
  const na = selectNeedsAttention(agents, cards)
  const empty = needsAttentionEmpty(na)
  const count = na.agents.length + na.cards.length

  // All-clear reads calm (cyan, quiet); anything needing a look gets an orange
  // rail + tinted header so it draws the eye first on the page.
  return (
    <section
      className={cn(
        'surface-card relative overflow-hidden rounded-xl border p-4 pl-5',
        'before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[""]',
        empty ? 'border-border before:bg-accent/40' : 'border-primary/40 before:bg-primary',
      )}
    >
      <header className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
        {empty ? (
          <ShieldCheck className="h-4 w-4 text-accent" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-primary" />
        )}
        Figyelmet kér
        {!empty && (
          <span className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
            {count}
          </span>
        )}
      </header>

      {empty ? (
        <p className="text-sm text-text-muted">Minden rendben. Semmi nem igényel figyelmet.</p>
      ) : (
        <div className="space-y-3">
          {na.agents.length > 0 && (
            <ul className="space-y-1.5">
              {na.agents.map((a) => (
                <li key={a.name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text transition-colors hover:bg-bg-elevated/50">
                  <StatusDot status={a.status} />
                  <span className="font-medium">{a.displayName}</span>
                  <span className="ml-auto text-xs text-text-muted">{AGENT_STATUS_LABEL[a.status]}</span>
                </li>
              ))}
            </ul>
          )}
          {na.cards.length > 0 && (
            <ul className="space-y-1.5">
              {na.cards.map((c) => (
                <li key={c.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text transition-colors hover:bg-bg-elevated/50">
                  <PriorityBadge priority={c.priority} />
                  <span className="min-w-0 flex-1 truncate">{truncate(c.title, 60)}</span>
                  <span className="shrink-0 text-xs text-text-muted">{agentDisplayName(c.assignee) ?? 'kiosztatlan'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
