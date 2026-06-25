import type { KanbanCard, KanbanStatus } from '@/types/api'
import { KANBAN_COLUMNS } from './status'

export type KanbanGroups = Record<KanbanStatus, KanbanCard[]>

/**
 * Group cards into the four board columns (AC-F0-7), preserving backend order
 * within each column. Cards with status `someday` (or any non-column status) are
 * dropped from the board. Pure -- unit-testable.
 */
export function groupCardsByStatus(cards: KanbanCard[]): KanbanGroups {
  const groups = {
    planned: [],
    in_progress: [],
    waiting: [],
    done: [],
  } as KanbanGroups
  for (const card of cards) {
    if ((KANBAN_COLUMNS as readonly string[]).includes(card.status)) {
      groups[card.status as KanbanStatus].push(card)
    }
  }
  return groups
}
