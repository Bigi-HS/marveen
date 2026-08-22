// Kanban graceful-degradation on Opus weekly cap (card 75a5ecc3).
//
// When the opus-fallback activates (channel-monitor detects weekly-cap and
// switches the agent to Sonnet), any in_progress kanban cards assigned to that
// agent should transition to 'waiting' with a comment so the card is not left
// silently stuck -- an operator can see it is paused for the weekly reset and
// will auto-resume on Sunday.

import { listCards, updateCard as noaUpdateCard, addComment, type KanbanCard, type UpdateCardParams } from '../noa-kanban.js'

export const OPUS_LIMIT_COMMENT =
  'Opus-limit: automatikusan Sonnet-fallbackre valtva. Folytatodik vasarnap reset utan.'

// Minimal card shape needed by the pure helper -- injectable for tests.
export type KanbanCardSlice = Pick<KanbanCard, 'id' | 'assignee' | 'status'>

export interface KanbanDeps {
  listCards(): KanbanCardSlice[]
  updateCard(id: string, fields: { status: string }): void
  addComment(cardId: string, author: string, content: string): void
}

// Pure: which cards should be moved? Exported for unit tests.
export function filterAgentInProgressCards(
  cards: KanbanCardSlice[],
  agentName: string,
): KanbanCardSlice[] {
  return cards.filter(c => c.assignee === agentName && c.status === 'in_progress')
}

/**
 * Move all in_progress cards assigned to `agentName` to 'waiting' and add the
 * Opus-limit comment to each. Returns the number of cards affected.
 *
 * Default deps call the live DB. Injectable for unit tests.
 */
export function markAgentCardsWaiting(
  agentName: string,
  comment: string,
  deps: KanbanDeps = {
    listCards,
    updateCard: (id, fields) => { noaUpdateCard(id, fields as UpdateCardParams) },
    addComment,
  },
): number {
  const affected = filterAgentInProgressCards(deps.listCards(), agentName)
  for (const c of affected) {
    deps.updateCard(c.id, { status: 'waiting' })
    deps.addComment(c.id, 'system', comment)
  }
  return affected.length
}
