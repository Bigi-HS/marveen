import type { KanbanCard, KanbanStatus } from '@/types/api'
import { KANBAN_COLUMNS } from './status'
import { CARD_PROJECTS, CONT_FAMILY, PROJECT_LANES } from './project'

// ---------------------------------------------------------------------------
// Aging + stale detection (card 31f24bad)
// Mirrors src/noa-kanban.ts logic -- keep in sync if thresholds change.
// ---------------------------------------------------------------------------

// Per-priority-score stale threshold in seconds. Mirrors backend STALE_THRESHOLD_SECONDS.
const STALE_THRESHOLD_SECONDS: Record<number, number> = {
  1: 2 * 3600,
  2: 12 * 3600,
  3: 24 * 3600, 4: 24 * 3600,
  5: 3 * 86400, 6: 3 * 86400, 7: 3 * 86400,
  8: 7 * 86400, 9: 7 * 86400, 10: 7 * 86400,
}

// The 07-29 taxonomy-backfill burst window (card 4326682b). updated_at inside
// this window is an unmeasured bulk stamp, not a real move.
const BULK_STAMP_BURST_START = 1785334212
const BULK_STAMP_BURST_END   = 1785334253

const ACTIVE_STATUSES = new Set(['planned', 'in_progress', 'waiting'])

/**
 * Effective age in seconds for aging display. Uses last_moved when available;
 * falls back to updated_at unless it falls inside the bulk-stamp burst window
 * (in which case we have no reliable anchor and return null).
 */
export function cardAgeSeconds(
  card: Pick<KanbanCard, 'updated_at' | 'last_moved'>,
  nowSec: number,
): number | null {
  if (card.last_moved !== null && card.last_moved !== undefined) {
    return nowSec - card.last_moved
  }
  const ts = card.updated_at
  if (ts >= BULK_STAMP_BURST_START && ts <= BULK_STAMP_BURST_END) return null
  return nowSec - ts
}

/**
 * Returns true/false/'unknown'. Mirrors backend isCardStale().
 * 'unknown' means the card may be stale but its age cannot be measured
 * (last_moved null + updated_at inside bulk-stamp burst window).
 */
export function isCardStale(
  card: Pick<KanbanCard, 'status' | 'priority_score' | 'updated_at' | 'last_moved'>,
  nowSec: number,
): boolean | 'unknown' {
  if (!ACTIVE_STATUSES.has(card.status)) return false
  const score = card.priority_score
  if (score === null || score === undefined) return false
  const threshold = STALE_THRESHOLD_SECONDS[score]
  if (threshold === undefined) return false

  if (card.last_moved !== null && card.last_moved !== undefined) {
    return nowSec - card.last_moved >= threshold
  }

  const ts = card.updated_at
  if (ts >= BULK_STAMP_BURST_START && ts <= BULK_STAMP_BURST_END) return 'unknown'
  return nowSec - ts >= threshold
}

/**
 * Format an age in seconds as a short human label: "2n" (nap), "5ó" (ora), "30p" (perc).
 * null input -> "-" (unmeasured).
 */
export function formatAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return '-'
  const days = Math.floor(ageSeconds / 86400)
  if (days >= 1) return `${days}n`
  const hours = Math.floor(ageSeconds / 3600)
  if (hours >= 1) return `${hours}ó`
  const mins = Math.floor(ageSeconds / 60)
  return `${mins}p`
}

/**
 * Returns active (planned/in_progress/waiting) cards that are stale or
 * potentially stale ('unknown'). Sorted: true-stale first, then unknown.
 */
export function getStaleCards(cards: KanbanCard[], nowSec: number): KanbanCard[] {
  const stale: KanbanCard[] = []
  const unknown: KanbanCard[] = []
  for (const c of cards) {
    const verdict = isCardStale(c, nowSec)
    if (verdict === true) stale.push(c)
    else if (verdict === 'unknown') unknown.push(c)
  }
  return [...stale, ...unknown]
}

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
 * Group cards by their project taxonomy prefix (card cf0d1bfe S3, enum-widen
 * Boss TG4599), for the project-grouped board view. Lanes come first in
 * PROJECT_LANES order; empty lanes are omitted (no empty columns). The
 * CONT-family (DUB/DL/DISC/BIGI) are canonical VALUES that fold into the single
 * CONT lane -- 5 codes, 1 visual lane. Cards whose project is null or
 * non-canonical collect into a single trailing group keyed `null` (the "Egyéb"
 * lane). Backend order is preserved within each group.
 *
 * Non-column statuses (someday/icebox) are dropped, exactly as groupCardsByStatus
 * does, so both board views render the same set of active cards. Pure.
 */
export function groupCardsByProject(cards: KanbanCard[]): ProjectGroup[] {
  const board = cards.filter((c) => (KANBAN_COLUMNS as readonly string[]).includes(c.status))
  const canonical = new Set<string>(CARD_PROJECTS)
  const family = new Set<string>(CONT_FAMILY)
  // Map a canonical project value to its display lane: CONT-family members fold
  // into the CONT lane; every other canonical value is its own lane.
  const laneOf = (project: string): string => (family.has(project) ? 'CONT' : project)

  const byLane = new Map<string, KanbanCard[]>()
  const other: KanbanCard[] = []
  for (const card of board) {
    if (card.project != null && canonical.has(card.project)) {
      const lane = laneOf(card.project)
      const bucket = byLane.get(lane) ?? []
      bucket.push(card)
      byLane.set(lane, bucket)
    } else {
      other.push(card)
    }
  }

  const groups: ProjectGroup[] = []
  for (const lane of PROJECT_LANES) {
    const bucket = byLane.get(lane)
    if (bucket && bucket.length > 0) groups.push({ project: lane, cards: bucket })
  }
  if (other.length > 0) groups.push({ project: null, cards: other })
  return groups
}
