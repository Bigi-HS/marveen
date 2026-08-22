import type { AgentGridItem, KanbanCard } from '@/types/api'
import { agentNeedsAttention } from './status'

export interface NeedsAttention {
  agents: AgentGridItem[]
  cards: KanbanCard[]
}

/**
 * AC-F0-5 "Needs attention" selector (pure):
 * - agents whose status is neither idle nor busy (error / offline / unknown)
 * - kanban cards with status `waiting` or `planned` AND priority `urgent` or `high`
 *
 * The component renders an explicit empty state when both lists are empty.
 */
export function selectNeedsAttention(agents: AgentGridItem[], cards: KanbanCard[]): NeedsAttention {
  return {
    agents: agents.filter((a) => agentNeedsAttention(a.status)),
    cards: cards.filter(
      (c) =>
        (c.status === 'waiting' || c.status === 'planned') &&
        (c.priority === 'urgent' || c.priority === 'high'),
    ),
  }
}

/** True when nothing needs attention -> render the explicit empty state. */
export function needsAttentionEmpty(na: NeedsAttention): boolean {
  return na.agents.length === 0 && na.cards.length === 0
}
