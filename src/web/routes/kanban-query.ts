/**
 * GET /api/kanban/query -- flexible kanban card query with filter + group-by (DASH-032, 34025179).
 *
 * Query parameters:
 *   status   -- comma-separated statuses (planned,in_progress,waiting,done,icebox)
 *   assignee -- exact match
 *   project  -- exact match
 *   priority -- comma-separated (low,normal,high,urgent)
 *   code     -- prefix match (e.g. ENG, DASH-)
 *   group_by -- status|project|assignee (default: none, returns flat list)
 *
 * Response:
 *   { cards: KanbanCardRow[] }                     -- when no group_by
 *   { groups: { key: string|null; cards: [] }[] }  -- when group_by set
 *
 * This is the data backend for the componentable filter x group-by x render widget.
 * The frontend renders the response as table/pie/2D-matrix/trend depending on context.
 */
import type Database from 'better-sqlite3'
import { getNoaDb } from '../../noa-db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export interface KanbanCardRow {
  id: string
  title: string
  status: string
  assignee: string | null
  priority: string
  project: string | null
  code: string | null
  priority_score: number | null
  last_moved: number | null
  updated_at: number
  created_at: number
}

const VALID_STATUSES = new Set(['planned', 'in_progress', 'waiting', 'done', 'icebox', 'someday'])
const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])
const VALID_GROUP_BY = new Set(['status', 'project', 'assignee'])

export interface QueryFilter {
  statuses?: string[]
  assignee?: string
  project?: string
  priorities?: string[]
  codePrefix?: string
}

export interface QueryGroupResult {
  key: string | null
  label: string
  cards: KanbanCardRow[]
}

/** Pure filter function for unit testing without DB. */
export function applyFilter(cards: KanbanCardRow[], filter: QueryFilter): KanbanCardRow[] {
  return cards.filter((c) => {
    if (filter.statuses?.length && !filter.statuses.includes(c.status)) return false
    if (filter.assignee != null && c.assignee !== filter.assignee) return false
    if (filter.project != null && c.project !== filter.project) return false
    if (filter.priorities?.length && !filter.priorities.includes(c.priority)) return false
    if (filter.codePrefix != null && !(c.code ?? '').startsWith(filter.codePrefix)) return false
    return true
  })
}

/** Pure group function -- returns groups in key order. */
export function groupCards(
  cards: KanbanCardRow[],
  groupBy: 'status' | 'project' | 'assignee',
): QueryGroupResult[] {
  const map = new Map<string | null, KanbanCardRow[]>()
  for (const card of cards) {
    const key = groupBy === 'status' ? card.status
      : groupBy === 'project' ? card.project
      : card.assignee
    const bucket = map.get(key) ?? []
    bucket.push(card)
    map.set(key, bucket)
  }
  // Sort: nulls last, then alphabetical
  const keys = [...map.keys()].sort((a, b) => {
    if (a === null) return 1
    if (b === null) return -1
    return a.localeCompare(b)
  })
  return keys.map((key) => ({
    key,
    label: key ?? '(none)',
    cards: map.get(key)!,
  }))
}

export function queryCards(
  filter: QueryFilter,
  db: Database.Database = getNoaDb(),
): KanbanCardRow[] {
  const rows = db.prepare(
    `SELECT id, title, status, assignee, priority, project, code, priority_score, last_moved, updated_at, created_at
       FROM kanban_cards
      WHERE archived_at IS NULL OR archived_at = 0
      ORDER BY sort_order ASC, created_at ASC`
  ).all() as KanbanCardRow[]
  return applyFilter(rows, filter)
}

export async function tryHandleKanbanQuery(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== '/api/kanban/query' || method !== 'GET') return false

  const p = ctx.url.searchParams
  const filter: QueryFilter = {}

  const statusParam = p.get('status')
  if (statusParam) {
    const statuses = statusParam.split(',').map(s => s.trim()).filter(s => VALID_STATUSES.has(s))
    if (statuses.length > 0) filter.statuses = statuses
  }

  const assigneeParam = p.get('assignee')
  if (assigneeParam) filter.assignee = assigneeParam

  const projectParam = p.get('project')
  if (projectParam) filter.project = projectParam

  const priorityParam = p.get('priority')
  if (priorityParam) {
    const priorities = priorityParam.split(',').map(s => s.trim()).filter(s => VALID_PRIORITIES.has(s))
    if (priorities.length > 0) filter.priorities = priorities
  }

  const codeParam = p.get('code')
  if (codeParam) filter.codePrefix = codeParam

  const groupByParam = p.get('group_by')
  const groupBy = groupByParam && VALID_GROUP_BY.has(groupByParam)
    ? groupByParam as 'status' | 'project' | 'assignee'
    : null

  const cards = queryCards(filter)

  if (groupBy) {
    json(res, { filter, group_by: groupBy, groups: groupCards(cards, groupBy) })
  } else {
    json(res, { filter, cards })
  }
  return true
}
