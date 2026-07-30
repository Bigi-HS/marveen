import type { KanbanCard, KanbanStatus } from '@/types/api'
import { KANBAN_COLUMNS } from './status'
import { CARD_PROJECTS } from './project'

export type KanbanGroups = Record<KanbanStatus, KanbanCard[]>

/** A project swimlane: a canonical prefix (or null for the uncategorized bucket)
 *  and the board cards under it, in backend order. */
export interface ProjectGroup {
  project: string | null
  cards: KanbanCard[]
}

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

/**
 * Group cards by their project taxonomy prefix (card cf0d1bfe S3), for the
 * project-grouped board view. Canonical projects come first in CARD_PROJECTS
 * order; empty canonical projects are omitted (no 14 empty lanes). Cards whose
 * project is null or non-canonical collect into a single trailing group keyed
 * `null` (the "Egyéb" lane). Backend order is preserved within each group.
 *
 * Non-column statuses (someday/icebox) are dropped, exactly as groupCardsByStatus
 * does, so both board views render the same set of active cards. Pure.
 */
export function groupCardsByProject(cards: KanbanCard[]): ProjectGroup[] {
  const board = cards.filter((c) => (KANBAN_COLUMNS as readonly string[]).includes(c.status))
  const canonical = new Set<string>(CARD_PROJECTS)

  const byProject = new Map<string, KanbanCard[]>()
  const other: KanbanCard[] = []
  for (const card of board) {
    if (card.project != null && canonical.has(card.project)) {
      const bucket = byProject.get(card.project) ?? []
      bucket.push(card)
      byProject.set(card.project, bucket)
    } else {
      other.push(card)
    }
  }

  const groups: ProjectGroup[] = []
  for (const project of CARD_PROJECTS) {
    const bucket = byProject.get(project)
    if (bucket && bucket.length > 0) groups.push({ project, cards: bucket })
  }
  if (other.length > 0) groups.push({ project: null, cards: other })
  return groups
}
