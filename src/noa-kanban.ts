import { randomUUID } from 'node:crypto'
import { getNoaDb } from './noa-db.js'
import { emitDashboardEvent, type DashboardEvent } from './event-bus.js'
import { MAIN_AGENT_ID, OWNER_NAME, BOT_NAME } from './config.js'
import { listAgentNames } from './web/agent-config.js'
import { resolveKanbanDispatchTarget } from './kanban-dispatch.js'
import { logger } from './logger.js'

// ---------------------------------------------------------------------------
// Transaction-aware event buffering (mirrors db.ts runInTransaction pattern)
// ---------------------------------------------------------------------------

let txEventBuffer: DashboardEvent[] | null = null

function emitOrDefer(event: DashboardEvent): void {
  if (txEventBuffer) txEventBuffer.push(event)
  else emitDashboardEvent(event)
}

export function runInTransaction<T>(fn: () => T): T {
  if (txEventBuffer) return getNoaDb().transaction(fn)() // nested: outer owns the buffer
  txEventBuffer = []
  try {
    const result = getNoaDb().transaction(fn)()
    const buffered = txEventBuffer
    txEventBuffer = null
    for (const e of buffered) emitDashboardEvent(e)
    return result
  } catch (err) {
    txEventBuffer = null
    throw err
  }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class InvalidStatusError extends Error {
  constructor(status: string) {
    super(`'${status}' is not a valid board column id`)
    this.name = 'InvalidStatusError'
  }
}

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Transition from '${from}' to '${to}' is not allowed`)
    this.name = 'InvalidTransitionError'
  }
}

export class InvalidSortOrderError extends Error {
  constructor(sortOrder: number) {
    super(`sort_order must be a positive number, got ${sortOrder}`)
    this.name = 'InvalidSortOrderError'
  }
}

export class InvalidPriorityScoreError extends Error {
  constructor(score: unknown) {
    super(`priority_score must be an integer 1-10, got ${String(score)}`)
    this.name = 'InvalidPriorityScoreError'
  }
}

export class CrossColumnReorderError extends Error {
  constructor() {
    super('All cards in reorderCards must belong to the same status column')
    this.name = 'CrossColumnReorderError'
  }
}

export class ParentNotFoundError extends Error {
  constructor(parentId: string) {
    super(`Parent card '${parentId}' not found or is archived`)
    this.name = 'ParentNotFoundError'
  }
}

export class HasActiveChildrenError extends Error {
  constructor(id: string) {
    super(`Card '${id}' has active (non-done/archived) children`)
    this.name = 'HasActiveChildrenError'
  }
}

export class ColumnNotEmptyError extends Error {
  constructor(id: string) {
    super(`Column '${id}' has active cards and cannot be deleted`)
    this.name = 'ColumnNotEmptyError'
  }
}

export class BuiltinColumnError extends Error {
  constructor(id: string) {
    super(`Column '${id}' is a built-in column and cannot be deleted`)
    this.name = 'BuiltinColumnError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KanbanCard {
  id: string
  title: string
  description: string | null
  status: string
  assignee: string | null
  priority: string
  project: string | null
  parent_id: string | null
  due_date: number | null
  sort_order: number
  created_at: number
  updated_at: number
  archived_at: number | null
  dispatched_at: number | null
  /** 1-10 fine-grained attention rank (1 = top). NULL = parked (icebox lane). */
  priority_score: number | null
}

export interface BoardColumn {
  id: string
  label: string
  sort_order: number
  is_terminal: number
  created_at: number
  updated_at: number
}

export interface KanbanComment {
  id: number
  card_id: string
  author: string
  content: string
  created_at: number
}

export interface CreateCardParams {
  id?: string
  title: string
  description?: string | null
  status?: string
  assignee?: string | null
  priority?: string
  priority_score?: number | null
  project?: string | null
  parent_id?: string | null
  due_date?: number | null
  sort_order?: number
  suppressIntake?: boolean
}

export interface UpdateCardParams {
  title?: string
  description?: string | null
  status?: string
  assignee?: string | null
  priority?: string
  priority_score?: number | null
  project?: string | null
  parent_id?: string | null
  due_date?: number | null
  sort_order?: number
  suppressIntake?: boolean
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const BUILTIN_STATUSES = new Set(['planned', 'in_progress', 'waiting', 'done', 'icebox'])

// 'icebox' is the parked lane (renamed from legacy 'someday', card 65afc67e). It is
// reachable from any active column (park) and revives back to planned/in_progress.
const ALLOWED_TRANSITIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['planned',     new Set(['in_progress', 'waiting', 'icebox', 'done'])],
  ['in_progress', new Set(['waiting', 'done', 'planned', 'icebox'])],
  ['waiting',     new Set(['in_progress', 'planned', 'done', 'icebox'])],
  ['icebox',      new Set(['planned', 'in_progress'])],
  ['done',        new Set(['planned'])],
])

const DONE_ARCHIVE_DAYS = Number(process.env.DONE_ARCHIVE_DAYS ?? '7')

const BUILTIN_COLUMNS = new Set(['planned', 'in_progress', 'waiting', 'done', 'icebox'])

// ---------------------------------------------------------------------------
// Priority score (1-10 fine-grained attention rank, card 65afc67e)
// ---------------------------------------------------------------------------

// The parked lane carries no score (excluded from drain/heartbeat ordering).
const PARKED_STATUS = 'icebox'

// Default score for a new/active card when no explicit 1-10 is given: the centre
// of its priority bucket. Mirrors the live-data backfill so create and migrate agree.
function bucketCenterScore(priority: string | null | undefined): number {
  switch (priority) {
    case 'urgent': return 2
    case 'high':   return 4
    case 'low':    return 9
    case 'normal':
    default:       return 6
  }
}

// Throws InvalidPriorityScoreError unless v is an integer in [1,10]. NULL/undefined
// are caller-validated separately (NULL is only legal for the parked lane).
function assertValidPriorityScore(v: unknown): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10) {
    throw new InvalidPriorityScoreError(v)
  }
}

// Resolve the score to persist for a card given its status + requested values.
// Parked (icebox) cards always store NULL; active cards take the explicit score
// (validated) or fall back to the bucket centre of their priority.
function resolvePriorityScore(status: string, priority: string | null | undefined, explicit: number | null | undefined): number | null {
  if (status === PARKED_STATUS) return null
  if (explicit === null || explicit === undefined) return bucketCenterScore(priority)
  assertValidPriorityScore(explicit)
  return explicit
}

// Recompute a card's score on update. An explicit value always wins (validated).
// Otherwise: parking clears the score; reviving from the parked lane or a legacy
// NULL gets a bucket centre; a priority-bucket change re-centres; else unchanged.
function computeUpdatedScore(
  card: KanbanCard,
  params: UpdateCardParams,
  newStatus: string,
  newPriority: string,
): number | null {
  if (params.priority_score !== undefined) return resolvePriorityScore(newStatus, newPriority, params.priority_score)
  if (newStatus === PARKED_STATUS) return null
  if (card.priority_score === null) return bucketCenterScore(newPriority)
  if (params.priority !== undefined && params.priority !== card.priority) return bucketCenterScore(newPriority)
  return card.priority_score
}

// Per-level stale threshold in seconds (card 65afc67e rubric §4): how long a card
// may sit untouched before it is a red flag. Parked cards never go stale.
const STALE_THRESHOLD_SECONDS: Record<number, number> = {
  1: 2 * 3600,        // SEV1: 2h
  2: 12 * 3600,       // urgent: half a day
  3: 24 * 3600, 4: 24 * 3600,                 // high: 1 day
  5: 3 * 86400, 6: 3 * 86400, 7: 3 * 86400,   // normal: 3 days
  8: 7 * 86400, 9: 7 * 86400, 10: 7 * 86400,  // low: 7 days
}

export function staleThresholdSeconds(score: number | null): number | null {
  if (score === null || score === undefined) return null
  return STALE_THRESHOLD_SECONDS[score] ?? null
}

export function isCardStale(card: Pick<KanbanCard, 'priority_score' | 'updated_at' | 'status'>, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  if (card.status === PARKED_STATUS || card.status === 'done') return false
  const threshold = staleThresholdSeconds(card.priority_score)
  if (threshold === null) return false
  return nowSec - card.updated_at >= threshold
}

// ---------------------------------------------------------------------------
// Schema migration (additive, idempotent -- mirrors noa-scheduler applyBBlockColumns)
// ---------------------------------------------------------------------------

const KANBAN_MIGRATIONS = [
  `ALTER TABLE kanban_cards ADD COLUMN priority_score INTEGER`,
]

export function applyKanbanMigrations(db = getNoaDb()): void {
  for (const stmt of KANBAN_MIGRATIONS) {
    try { db.exec(stmt) } catch { /* column already exists -- ok */ }
  }
  // Migrate any legacy 'someday' cards into the canonical 'icebox' parked lane
  // (runs independently so it is never skipped by a column-reconcile failure).
  try {
    db.exec(`UPDATE kanban_cards SET status = 'icebox' WHERE status = 'someday'`)
  } catch { /* table absent in a partial schema -- ok */ }
  // Reconcile the board_columns lane: rename someday->icebox when icebox does not
  // yet exist (live noa.db); if both exist (a fresh schema already seeds icebox),
  // drop the orphan someday column so there is exactly ONE parking lane.
  try {
    const hasSomeday = db.prepare("SELECT 1 FROM board_columns WHERE id = 'someday'").get()
    const hasIcebox = db.prepare("SELECT 1 FROM board_columns WHERE id = 'icebox'").get()
    if (hasSomeday && !hasIcebox) {
      db.exec(`UPDATE board_columns SET id = 'icebox', label = 'Jegelve' WHERE id = 'someday'`)
    } else if (hasSomeday && hasIcebox) {
      db.exec(`DELETE FROM board_columns WHERE id = 'someday'`)
    }
    invalidateColumnsCache()
  } catch { /* board_columns absent in a partial schema -- ok */ }
  // Backfill bucket-centre scores for active cards that predate the column.
  // Parked (icebox) cards stay NULL by design (excluded from ordering).
  try {
    db.exec(`UPDATE kanban_cards SET priority_score = CASE priority
        WHEN 'urgent' THEN 2 WHEN 'high' THEN 4 WHEN 'low' THEN 9 ELSE 6 END
      WHERE priority_score IS NULL AND status != 'icebox' AND archived_at IS NULL`)
  } catch { /* ok */ }
}

// ---------------------------------------------------------------------------
// Dispatch config (injectable for tests)
// ---------------------------------------------------------------------------

let _isRunning: (name: string) => boolean = () => false
let _agentNamesOverride: string[] | null = null

export function configureKanban(opts: { isRunning?: (name: string) => boolean; agentNames?: string[] }): void {
  if (opts.isRunning !== undefined) _isRunning = opts.isRunning
  if (opts.agentNames !== undefined) _agentNamesOverride = opts.agentNames
}

// ---------------------------------------------------------------------------
// Column cache (refreshed on board_columns change)
// ---------------------------------------------------------------------------

let _validStatusIds: Set<string> | null = null

function getValidStatusIds(): Set<string> {
  if (!_validStatusIds) {
    const rows = getNoaDb().prepare('SELECT id FROM board_columns').all() as { id: string }[]
    _validStatusIds = new Set(rows.map((r) => r.id))
  }
  return _validStatusIds
}

export function invalidateColumnsCache(): void {
  _validStatusIds = null
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertValidTransition(fromStatus: string, toStatus: string): void {
  // Validate against board_columns cache -- 'archived' is not a column so it fails here (AC-1, AC-2a)
  const validIds = getValidStatusIds()
  if (!validIds.has(toStatus)) throw new InvalidStatusError(toStatus)
  // Same-status is a valid no-op move (spec section 5 edge case)
  if (fromStatus === toStatus) return

  // For builtin source statuses: check the explicit allowed-targets list.
  // If toStatus is also a builtin and not in the allowed set -> forbidden.
  // If toStatus is a custom column (not a builtin) -> open-to-open; allowed.
  const allowed = ALLOWED_TRANSITIONS.get(fromStatus)
  if (allowed !== undefined && !allowed.has(toStatus) && BUILTIN_STATUSES.has(toStatus)) {
    throw new InvalidTransitionError(fromStatus, toStatus)
  }
  // Custom source statuses: no explicit transition table; only the builtin checks above apply.
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getCard(id: string): KanbanCard | undefined {
  return getNoaDb().prepare('SELECT * FROM kanban_cards WHERE id = ?').get(id) as KanbanCard | undefined
}

function maxSortOrderInStatus(status: string): number {
  const row = getNoaDb().prepare(
    'SELECT MAX(sort_order) as m FROM kanban_cards WHERE status = ? AND archived_at IS NULL'
  ).get(status) as { m: number | null }
  return row?.m ?? 0
}

function checkAllChildrenDone(parentId: string): void {
  const db = getNoaDb()
  const total = (db.prepare('SELECT COUNT(*) as n FROM kanban_cards WHERE parent_id = ?').get(parentId) as { n: number }).n
  if (total === 0) return
  const active = (db.prepare(
    "SELECT COUNT(*) as n FROM kanban_cards WHERE parent_id = ? AND status != 'done' AND archived_at IS NULL"
  ).get(parentId) as { n: number }).n
  if (active === 0) {
    emitOrDefer({ type: 'kanban', id: parentId, action: 'children_all_done' })
  }
}

function maybeEmitIntake(card: KanbanCard): void {
  if (card.status === PARKED_STATUS) return
  if (card.assignee) {
    const knownAgents = new Set([MAIN_AGENT_ID, ...(_agentNamesOverride ?? listAgentNames())])
    if (knownAgents.has(card.assignee)) return
  }
  emitOrDefer({
    type: 'kanban',
    id: card.id,
    action: 'intake',
    card: {
      id: card.id,
      title: card.title,
      description: card.description ?? null,
      assignee: card.assignee ?? null,
      priority: card.priority,
      status: card.status,
    },
  })
}

function dispatchCard(card: KanbanCard): void {
  try {
    // AC-3a: skip if already dispatched (re-check inside try for fire-and-forget isolation)
    const current = getNoaDb().prepare('SELECT dispatched_at FROM kanban_cards WHERE id = ?').get(card.id) as { dispatched_at: number | null } | undefined
    if (!current || current.dispatched_at !== null) return

    const target = resolveKanbanDispatchTarget(card.assignee, {
      ownerName: OWNER_NAME,
      botName: BOT_NAME,
      mainAgentId: MAIN_AGENT_ID,
      agentNames: _agentNamesOverride ?? listAgentNames(),
      isRunning: _isRunning,
    })
    if (!target) return

    // T1 race guard: UPDATE WHERE dispatched_at IS NULL ensures only one winner
    const raceResult = getNoaDb().prepare(
      'UPDATE kanban_cards SET dispatched_at = unixepoch() WHERE id = ? AND dispatched_at IS NULL'
    ).run(card.id)
    if (raceResult.changes === 0) return

    const content = `[Kanban #${card.id}] ${card.title} -- kartyad in_progress-re kerult. Ha kesz vagy, huzd done-ra.`
    const now = Math.floor(Date.now() / 1000)
    getNoaDb().prepare(
      'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, ack_expected, priority, in_reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(MAIN_AGENT_ID, target, content, 'pending', now, 0, 50, null)

    emitOrDefer({ type: 'message', id: String(now), action: 'created' })
  } catch (err) {
    logger.warn({ err, cardId: card.id }, 'Kanban dispatch failed (fire-and-forget)')
  }
}

// ---------------------------------------------------------------------------
// Card CRUD
// ---------------------------------------------------------------------------

export function createCard(params: CreateCardParams): KanbanCard {
  const db = getNoaDb()
  const now = Math.floor(Date.now() / 1000)
  const status = params.status ?? 'planned'
  const id = params.id ?? randomUUID().slice(0, 8)

  // Validate status via board_columns cache (AC-1; 'archived' is not a column and fails here)
  const validIds = getValidStatusIds()
  if (!validIds.has(status)) throw new InvalidStatusError(status)

  // Check parent exists and is not archived
  if (params.parent_id) {
    const parent = db.prepare('SELECT id, archived_at FROM kanban_cards WHERE id = ?').get(params.parent_id) as { id: string; archived_at: number | null } | undefined
    if (!parent || parent.archived_at !== null) throw new ParentNotFoundError(params.parent_id)
  }

  const sortOrder = params.sort_order !== undefined ? params.sort_order : maxSortOrderInStatus(status) + 1.0
  const priority = params.priority ?? 'normal'
  const priorityScore = resolvePriorityScore(status, priority, params.priority_score)

  db.prepare(
    `INSERT INTO kanban_cards (id, title, description, status, assignee, priority, project, parent_id, due_date, sort_order, created_at, updated_at, priority_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, params.title, params.description ?? null, status,
    params.assignee ?? null, priority,
    params.project ?? null, params.parent_id ?? null, params.due_date ?? null,
    sortOrder, now, now, priorityScore,
  )

  emitOrDefer({ type: 'kanban', id, action: 'created' })

  const card = getCard(id)!

  if (!params.suppressIntake) {
    maybeEmitIntake(card)
  }

  return card
}

export { getCard }

export function updateCard(id: string, params: UpdateCardParams): boolean {
  const card = getCard(id)
  if (!card) return false

  // Validate status transition if status changes
  if (params.status !== undefined && params.status !== card.status) {
    assertValidTransition(card.status, params.status)
  }

  const now = Math.floor(Date.now() / 1000)
  const prevTitle = card.title
  const prevDescription = card.description

  const newStatus = params.status ?? card.status
  const newPriority = params.priority ?? card.priority

  const f: KanbanCard = {
    ...card,
    title: params.title ?? card.title,
    description: params.description !== undefined ? params.description : card.description,
    status: newStatus,
    assignee: params.assignee !== undefined ? params.assignee : card.assignee,
    priority: newPriority,
    priority_score: computeUpdatedScore(card, params, newStatus, newPriority),
    project: params.project !== undefined ? params.project : card.project,
    parent_id: params.parent_id !== undefined ? params.parent_id : card.parent_id,
    due_date: params.due_date !== undefined ? params.due_date : card.due_date,
    sort_order: params.sort_order ?? card.sort_order,
    updated_at: now,
  }

  const changed = getNoaDb().prepare(
    `UPDATE kanban_cards SET title=?, description=?, status=?, assignee=?, priority=?, project=?, parent_id=?, due_date=?, sort_order=?, updated_at=?, priority_score=?
     WHERE id=?`
  ).run(f.title, f.description, f.status, f.assignee, f.priority, f.project, f.parent_id, f.due_date, f.sort_order, f.updated_at, f.priority_score, id).changes > 0

  if (!changed) return false

  emitOrDefer({ type: 'kanban', id, action: 'updated' })

  // Dispatch if entered in_progress
  if (f.status === 'in_progress' && card.status !== 'in_progress') {
    dispatchCard({ ...f, id })
  }

  // Check all children done when this card (as a child) moves to done
  if (f.status === 'done' && card.status !== 'done' && card.parent_id) {
    checkAllChildrenDone(card.parent_id)
  }

  // Emit intake if title or description changed
  const titleChanged = f.title !== prevTitle
  const descChanged = f.description !== prevDescription
  if ((titleChanged || descChanged) && !params.suppressIntake) {
    maybeEmitIntake({ ...f, id })
  }

  return true
}

export function moveCard(id: string, toStatus: string, sortOrder: number): boolean {
  if (sortOrder <= 0) throw new InvalidSortOrderError(sortOrder)

  const card = getCard(id)
  if (!card) return false

  // Archived card cannot be moved without unarchiving first (AC-2b)
  if (card.archived_at !== null) {
    throw new InvalidTransitionError(card.status, toStatus)
  }

  assertValidTransition(card.status, toStatus)

  const now = Math.floor(Date.now() / 1000)
  // Crossing the icebox boundary adjusts the score: parking clears it; reviving an
  // unscored card to an active lane gives it a bucket centre. Otherwise unchanged.
  const newScore = computeUpdatedScore(card, { status: toStatus }, toStatus, card.priority)
  const changed = getNoaDb().prepare(
    'UPDATE kanban_cards SET status=?, sort_order=?, updated_at=?, priority_score=? WHERE id=?'
  ).run(toStatus, sortOrder, now, newScore, id).changes > 0

  if (!changed) return false

  emitOrDefer({ type: 'kanban', id, action: 'moved' })

  // Dispatch on entering in_progress (fire-and-forget)
  if (toStatus === 'in_progress') {
    dispatchCard({ ...card, status: toStatus })
  }

  // Check all children done if this card (as a child) moves to done
  if (toStatus === 'done' && card.parent_id) {
    checkAllChildrenDone(card.parent_id)
  }

  return true
}

export function archiveCard(id: string): boolean {
  const card = getCard(id)
  if (!card) return false
  // No-op if already archived (AC-5 edge case)
  if (card.archived_at !== null) return true

  const now = Math.floor(Date.now() / 1000)
  getNoaDb().prepare('UPDATE kanban_cards SET archived_at=?, updated_at=? WHERE id=?').run(now, now, id)
  emitOrDefer({ type: 'kanban', id, action: 'archived' })

  // Check all children done (archiving a child counts as removing it from active)
  if (card.parent_id) checkAllChildrenDone(card.parent_id)

  return true
}

export function unarchiveCard(id: string): boolean {
  const card = getCard(id)
  if (!card) return false

  // Place at end of current status column
  const newSortOrder = maxSortOrderInStatus(card.status) + 1.0
  const now = Math.floor(Date.now() / 1000)
  const changed = getNoaDb().prepare(
    'UPDATE kanban_cards SET archived_at=NULL, sort_order=?, updated_at=? WHERE id=?'
  ).run(newSortOrder, now, id).changes > 0

  if (changed) emitOrDefer({ type: 'kanban', id, action: 'unarchived' })
  return changed
}

export function deleteCard(id: string): boolean {
  const card = getCard(id)
  if (!card) return false

  const db = getNoaDb()
  const allChildren = db.prepare(
    'SELECT id, status, archived_at FROM kanban_cards WHERE parent_id = ?'
  ).all(id) as Array<{ id: string; status: string; archived_at: number | null }>

  const hasActive = allChildren.some((c) => c.status !== 'done' && c.archived_at === null)
  if (hasActive) throw new HasActiveChildrenError(id)

  // Delete children first (application-layer cascade)
  for (const child of allChildren) {
    db.prepare('DELETE FROM kanban_comments WHERE card_id = ?').run(child.id)
    db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(child.id)
  }

  db.prepare('DELETE FROM kanban_comments WHERE card_id = ?').run(id)
  db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(id)
  emitOrDefer({ type: 'kanban', id, action: 'deleted' })
  return true
}

export function listCards(filter?: { status?: string }): KanbanCard[] {
  const db = getNoaDb()
  if (filter?.status) {
    return db.prepare(
      'SELECT * FROM kanban_cards WHERE status=? AND archived_at IS NULL ORDER BY sort_order ASC'
    ).all(filter.status) as KanbanCard[]
  }
  return db.prepare(
    'SELECT * FROM kanban_cards WHERE archived_at IS NULL ORDER BY status, sort_order ASC'
  ).all() as KanbanCard[]
}

export function listArchived(): KanbanCard[] {
  return getNoaDb().prepare(
    'SELECT * FROM kanban_cards WHERE archived_at IS NOT NULL ORDER BY archived_at DESC'
  ).all() as KanbanCard[]
}

export function getChildCards(parentId: string): KanbanCard[] {
  return getNoaDb().prepare(
    'SELECT * FROM kanban_cards WHERE parent_id=? AND archived_at IS NULL ORDER BY sort_order ASC'
  ).all(parentId) as KanbanCard[]
}

export function reorderCards(updates: Array<{ id: string; sort_order: number }>): void {
  if (updates.length === 0) return
  const db = getNoaDb()

  // Verify all cards belong to the same status column
  const statuses = updates.map((u) => {
    const row = db.prepare('SELECT status FROM kanban_cards WHERE id=?').get(u.id) as { status: string } | undefined
    return row?.status
  })
  const unique = new Set(statuses.filter(Boolean))
  if (unique.size > 1) throw new CrossColumnReorderError()

  const stmt = db.prepare('UPDATE kanban_cards SET sort_order=?, updated_at=? WHERE id=?')
  const now = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    for (const u of updates) stmt.run(u.sort_order, now, u.id)
  })()
}

export function addComment(cardId: string, author: string, content: string): KanbanComment {
  const now = Math.floor(Date.now() / 1000)
  const info = getNoaDb().prepare(
    'INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(cardId, author, content, now)
  emitOrDefer({ type: 'kanban', id: cardId, action: 'comment' })
  return { id: Number(info.lastInsertRowid), card_id: cardId, author, content, created_at: now }
}

export function listComments(cardId: string): KanbanComment[] {
  return getNoaDb().prepare(
    'SELECT * FROM kanban_comments WHERE card_id=? ORDER BY created_at ASC'
  ).all(cardId) as KanbanComment[]
}

// ---------------------------------------------------------------------------
// Archive sweep (AC-4)
// ---------------------------------------------------------------------------

export function runArchiveSweep(): { archived: number } {
  const threshold = Math.floor(Date.now() / 1000) - DONE_ARCHIVE_DAYS * 86400
  const result = getNoaDb().prepare(
    `UPDATE kanban_cards SET archived_at=unixepoch(), updated_at=unixepoch()
     WHERE status='done' AND archived_at IS NULL AND updated_at < ?`
  ).run(threshold)
  return { archived: result.changes }
}

// ---------------------------------------------------------------------------
// Column management (AC-9, AC-10)
// ---------------------------------------------------------------------------

export function listColumns(): BoardColumn[] {
  return getNoaDb().prepare(
    'SELECT * FROM board_columns ORDER BY sort_order ASC'
  ).all() as BoardColumn[]
}

export function createColumn(label: string, sortOrder?: number): BoardColumn {
  const db = getNoaDb()
  const now = Math.floor(Date.now() / 1000)
  const id = `custom-${randomUUID().slice(0, 8)}`
  const maxRow = db.prepare('SELECT MAX(sort_order) as m FROM board_columns').get() as { m: number | null }
  const finalSortOrder = sortOrder ?? (maxRow?.m ?? 0) + 1.0

  db.prepare(
    'INSERT INTO board_columns (id, label, sort_order, is_terminal, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)'
  ).run(id, label, finalSortOrder, now, now)

  invalidateColumnsCache()
  emitOrDefer({ type: 'board', id, action: 'column_created' })

  return { id, label, sort_order: finalSortOrder, is_terminal: 0, created_at: now, updated_at: now }
}

export function renameColumn(id: string, label: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  const changed = getNoaDb().prepare(
    'UPDATE board_columns SET label=?, updated_at=? WHERE id=?'
  ).run(label, now, id).changes > 0
  if (changed) emitOrDefer({ type: 'board', id, action: 'column_renamed' })
  return changed
}

export function reorderColumns(updates: Array<{ id: string; sort_order: number }>): void {
  if (updates.length === 0) return
  const db = getNoaDb()
  const stmt = db.prepare('UPDATE board_columns SET sort_order=?, updated_at=? WHERE id=?')
  const now = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    for (const u of updates) stmt.run(u.sort_order, now, u.id)
  })()
}

export function deleteColumn(id: string): boolean {
  if (BUILTIN_COLUMNS.has(id)) throw new BuiltinColumnError(id)

  const db = getNoaDb()
  const col = db.prepare('SELECT id FROM board_columns WHERE id=?').get(id) as { id: string } | undefined
  if (!col) return false

  const activeCount = (db.prepare(
    'SELECT COUNT(*) as n FROM kanban_cards WHERE status=? AND archived_at IS NULL'
  ).get(id) as { n: number }).n
  if (activeCount > 0) throw new ColumnNotEmptyError(id)

  db.prepare('DELETE FROM board_columns WHERE id=?').run(id)
  invalidateColumnsCache()
  return true
}

// ---------------------------------------------------------------------------
// W0b gap-fill exports (route-wiring prerequisites)
// ---------------------------------------------------------------------------

export function listProjects(): string[] {
  const rows = getNoaDb().prepare(
    "SELECT DISTINCT project FROM kanban_cards WHERE project IS NOT NULL AND project != '' AND archived_at IS NULL ORDER BY project"
  ).all() as Array<{ project: string }>
  return rows.map((r) => r.project)
}

export function markCardDispatched(id: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return getNoaDb().prepare('UPDATE kanban_cards SET dispatched_at=COALESCE(dispatched_at, ?) WHERE id=?').run(now, id).changes > 0
}

export interface HeartbeatKanbanSummary {
  urgent: KanbanCard[]
  in_progress: KanbanCard[]
  waiting: KanbanCard[]
}

export function listKanbanCardsSummary(): Array<{ id: string; title: string; status: string; assignee: string | null; priority: string; priority_score: number | null }> {
  // Attention order (card 65afc67e): within each column the lowest priority_score
  // (1 = top) comes first; parked/legacy NULLs sort last so they never lead.
  return getNoaDb().prepare(
    `SELECT id, title, status, assignee, priority, priority_score FROM kanban_cards
     WHERE archived_at IS NULL ORDER BY status, priority_score IS NULL, priority_score ASC, sort_order ASC`
  ).all() as Array<{ id: string; title: string; status: string; assignee: string | null; priority: string; priority_score: number | null }>
}

export function getHeartbeatKanbanSummary(): HeartbeatKanbanSummary {
  const db = getNoaDb()
  // Attention order (card 65afc67e): lowest priority_score first (1 = top). The
  // parked 'icebox' lane is excluded everywhere -- it never demands attention.
  const ORDER = 'ORDER BY priority_score IS NULL, priority_score ASC, sort_order ASC'
  const urgent = db.prepare(
    `SELECT * FROM kanban_cards WHERE archived_at IS NULL AND priority = 'urgent' AND status NOT IN ('done','icebox') ${ORDER}`
  ).all() as KanbanCard[]
  const in_progress = db.prepare(
    `SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'in_progress' ${ORDER}`
  ).all() as KanbanCard[]
  const waiting = db.prepare(
    `SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'waiting' ${ORDER}`
  ).all() as KanbanCard[]
  return { urgent, in_progress, waiting }
}
