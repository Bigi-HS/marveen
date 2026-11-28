import { randomUUID } from 'node:crypto'
import {
  listCards, listArchived, createCard, updateCard, deleteCard, moveCard, archiveCard,
  listComments, addComment, listProjects, getCard, getChildCards, runInTransaction,
  InvalidTransitionError, InvalidStatusError, InvalidSortOrderError, HasActiveChildrenError,
  ParentNotFoundError, InvalidProjectError, assertProjectPresent,
  patchTriage, TriageWeakenError,
} from '../../noa-kanban.js'
import { getNoaDb } from '../../noa-memory.js'
import { OWNER_NAME, BOT_NAME } from '../../config.js'
import { listAgentNames, readAgentDisplayName, findAvatarForAgent } from '../agent-config.js'
import { generateBreakdown } from '../llm-breakdown.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const KANBAN_LIMIT_DEFAULT = 200
const KANBAN_LIMIT_MAX = 500

/**
 * Raised when parked_until is present but cannot be normalized to an epoch-seconds
 * integer. The route maps it to HTTP 400 (fail-closed), mirroring the
 * KNOWN_PUT_FIELDS / assertProjectPresent pattern. See card 0a1c5102.
 */
export class InvalidParkedUntilError extends Error {
  constructor(public readonly value: unknown) {
    super(`parked_until must be an epoch-seconds integer or an ISO date/datetime string, got: ${JSON.stringify(value)}`)
    this.name = 'InvalidParkedUntilError'
  }
}

// Plausibility window for an epoch-seconds value, used to reject epoch-MILLIS and
// absurd inputs. Lower bound ~2001 (10^9 s); upper bound ~2286 (10^10 s). An
// epoch-millis value (e.g. 1.8e12) lands above this and is rejected, so a caller
// is forced to send seconds -- matching how the tick-driver/SLA compare
// parked_until against now-in-SECONDS (noa-kanban isStale, kanban-sla.ts).
const EPOCH_SECONDS_MIN = 1_000_000_000      // 2001-09-09
const EPOCH_SECONDS_MAX = 10_000_000_000     // 2286-11-20

/**
 * Validate/normalize an incoming `parked_until` to an epoch-SECONDS integer, so a
 * date STRING can never be persisted raw (root cause, card 0a1c5102 / 9cf177d4:
 * parked_until='2027-02-01' failed the tick-driver's parsed-epoch check and the
 * card was falsely treated as UNPARKED -> false stale-nudges every tick).
 *
 * Units are epoch SECONDS, confirmed by the readers: noa-kanban isStale()
 * (`card.parked_until > nowSec`) and kanban-sla.ts (`row.parked_until > nowSec`).
 *
 * Rules:
 *  - undefined  -> undefined  (field absent; updateCard leaves the column as-is)
 *  - null       -> null       (explicit unpark)
 *  - integer in the epoch-seconds window -> unchanged
 *  - 'YYYY-MM-DD' or a full ISO datetime string -> Math.floor(epoch-seconds)
 *  - anything else (garbage string, epoch-millis, non-finite, out-of-window int,
 *    non-integer number) -> throw InvalidParkedUntilError (route -> 400)
 */
export function coerceParkedUntil(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null

  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < EPOCH_SECONDS_MIN || value >= EPOCH_SECONDS_MAX) {
      throw new InvalidParkedUntilError(value)
    }
    return value
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    // A bare integer string is treated as an epoch-seconds int (same window check).
    if (/^-?\d+$/.test(trimmed)) {
      const n = Number(trimmed)
      if (!Number.isInteger(n) || n < EPOCH_SECONDS_MIN || n >= EPOCH_SECONDS_MAX) {
        throw new InvalidParkedUntilError(value)
      }
      return n
    }
    // ISO date (YYYY-MM-DD) or full ISO datetime. Date.parse treats a bare
    // YYYY-MM-DD as UTC midnight, which is the correct instant to store as an
    // absolute epoch (readers compare against an absolute now-epoch).
    const ms = Date.parse(trimmed)
    if (Number.isNaN(ms)) throw new InvalidParkedUntilError(value)
    const secs = Math.floor(ms / 1000)
    if (secs < EPOCH_SECONDS_MIN || secs >= EPOCH_SECONDS_MAX) {
      throw new InvalidParkedUntilError(value)
    }
    return secs
  }

  throw new InvalidParkedUntilError(value)
}

/**
 * Query kanban cards directly from the DB with status filtering and pagination.
 * Used by GET /api/kanban to avoid blocking the event loop with a full table
 * scan of 179+ cards when no status filter is provided.
 */
function queryCards(opts: {
  statusFilter?: string | null
  excludeStatuses?: string[]
  limit: number
  offset: number
}): unknown[] {
  const db = getNoaDb()
  const { statusFilter, excludeStatuses, limit, offset } = opts

  if (statusFilter) {
    return db.prepare(
      'SELECT * FROM kanban_cards WHERE status=? AND archived_at IS NULL ORDER BY sort_order ASC LIMIT ? OFFSET ?'
    ).all(statusFilter, limit, offset)
  }

  if (excludeStatuses && excludeStatuses.length > 0) {
    const placeholders = excludeStatuses.map(() => '?').join(', ')
    return db.prepare(
      `SELECT * FROM kanban_cards WHERE status NOT IN (${placeholders}) AND archived_at IS NULL ORDER BY status, sort_order ASC LIMIT ? OFFSET ?`
    ).all(...excludeStatuses, limit, offset)
  }

  // No filter: all non-archived cards with pagination
  return db.prepare(
    'SELECT * FROM kanban_cards WHERE archived_at IS NULL ORDER BY status, sort_order ASC LIMIT ? OFFSET ?'
  ).all(limit, offset)
}

export interface AssigneeEntry {
  name: string
  type: 'owner' | 'bot' | 'agent'
  displayName?: string
  /** True when the chip should render an avatar image instead of a letter dot. */
  hasImage?: boolean
  /** Avatar endpoint to use when hasImage is true. */
  avatarUrl?: string
}

/**
 * Build the kanban assignee list with per-entry avatar metadata. Pure +
 * dependency-injected so the avatar-flag wiring is unit-testable without the real
 * agents/ filesystem (mirrors the buildAgentConfigDir DI pattern). The card chip
 * (web/app.js) renders an <img> when hasImage is set, else the letter dot.
 *
 * - owner: the human owner has no avatar endpoint -> letter dot (no hasImage).
 * - bot: the orchestrator's avatar endpoint always serves an image (its own or a
 *   built-in fallback), so its chip can always render an image.
 * - agents: hasImage iff an avatar file exists; avatarUrl points at the
 *   per-agent avatar endpoint (404s when no file, hence the hasImage guard).
 */
export function buildAssigneeList(opts: {
  ownerName: string
  botName: string
  botAvatarUrl: string
  agentNames: string[]
  agentDisplayName: (name: string) => string | null
  agentHasAvatar: (name: string) => boolean
}): AssigneeEntry[] {
  const agents: AssigneeEntry[] = opts.agentNames.map((name) => ({
    name,
    type: 'agent',
    displayName: opts.agentDisplayName(name) || name,
    hasImage: opts.agentHasAvatar(name),
    avatarUrl: `/api/agents/${encodeURIComponent(name)}/avatar`,
  }))
  return [
    { name: opts.ownerName, type: 'owner' },
    { name: opts.botName, type: 'bot', hasImage: true, avatarUrl: opts.botAvatarUrl },
    ...agents,
  ]
}

export async function tryHandleKanban(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/kanban' && method === 'GET') {
    const { searchParams } = url
    const statusParam = searchParams.get('status')
    const limitParam = searchParams.get('limit')
    const offsetParam = searchParams.get('offset')

    const limit = Math.min(
      Math.max(parseInt(limitParam ?? '', 10) || KANBAN_LIMIT_DEFAULT, 1),
      KANBAN_LIMIT_MAX,
    )
    const offset = Math.max(parseInt(offsetParam ?? '', 10) || 0, 0)

    let cards
    if (statusParam === null) {
      // Default: exclude done/icebox to keep the query small and avoid blocking
      // the event loop for 10s on 179+ card boards (card fd95a6e6).
      cards = queryCards({ excludeStatuses: ['done', 'icebox'], limit, offset })
    } else if (statusParam === 'all') {
      cards = queryCards({ limit, offset })
    } else {
      cards = queryCards({ statusFilter: statusParam, limit, offset })
    }

    json(res, cards)
    return true
  }

  if (path === '/api/kanban/archived' && method === 'GET') {
    json(res, listArchived())
    return true
  }

  if (path === '/api/kanban-projects' && method === 'GET') {
    json(res, listProjects())
    return true
  }

  if (path === '/api/kanban/assignees' && method === 'GET') {
    json(res, buildAssigneeList({
      ownerName: OWNER_NAME,
      botName: BOT_NAME,
      // The orchestrator avatar is served at this fixed route (see marveen.ts),
      // which the frontend already uses for the bot/orchestrator everywhere.
      botAvatarUrl: '/api/marveen/avatar',
      agentNames: listAgentNames(),
      agentDisplayName: readAgentDisplayName,
      agentHasAvatar: (name) => findAvatarForAgent(name) !== null,
    }))
    return true
  }

  if (path === '/api/kanban' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    const id = randomUUID().slice(0, 8)
    try {
      // A new card must carry a canonical project code (card cf0d1bfe). Presence
      // is a create-time policy; the normalized value flows into the stored card.
      const project = assertProjectPresent(data.project)
      // parked_until must be a normalized epoch-seconds int, never a raw date
      // string (card 0a1c5102). undefined -> createCard applies its own default.
      const normalized = { ...data, project }
      const parked = coerceParkedUntil(data.parked_until)
      if (parked === undefined) delete normalized.parked_until
      else normalized.parked_until = parked
      createCard({ id, ...normalized })
    } catch (err) {
      if (err instanceof InvalidParkedUntilError) { json(res, { error: err.message }, 400); return true }
      if (err instanceof InvalidProjectError) { json(res, { error: err.message }, 400); return true }
      if (err instanceof InvalidStatusError) { json(res, { error: err.message }, 400); return true }
      if (err instanceof ParentNotFoundError) { json(res, { error: err.message }, 404); return true }
      throw err
    }
    json(res, { ok: true, id })
    return true
  }

  const kanbanCardMatch = path.match(/^\/api\/kanban\/([^/]+)$/)
  if (kanbanCardMatch && method === 'PUT') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    // Fail-closed on unknown fields (card f87f3448): an unrecognized key is
    // silently dropped by updateCard, giving the caller a false ok:true. Reject
    // instead so typos and stale field names surface immediately.
    const KNOWN_PUT_FIELDS = new Set([
      'title', 'description', 'status', 'assignee', 'priority', 'priority_score',
      'project', 'parent_id', 'depends_on', 'due_date', 'sort_order', 'suppressIntake',
      'parked_until', 'boss_waiting',
    ])
    const unknown = Object.keys(data).filter(k => !KNOWN_PUT_FIELDS.has(k))
    if (unknown.length > 0) {
      json(res, { error: `Unknown fields: ${unknown.join(', ')}`, unknown }, 400)
      return true
    }
    // Normalize parked_until to an epoch-seconds int before persisting (card
    // 0a1c5102). Only touch the key when it was actually present in the body, so
    // an untouched parked_until is left as-is by updateCard. Reject-before-write.
    if ('parked_until' in data) {
      try {
        data.parked_until = coerceParkedUntil(data.parked_until)
      } catch (err) {
        if (err instanceof InvalidParkedUntilError) { json(res, { error: err.message }, 400); return true }
        throw err
      }
    }
    try {
      if (updateCard(id, data)) { json(res, { ok: true }); return true }
    } catch (err) {
      if (
        err instanceof InvalidTransitionError ||
        err instanceof InvalidStatusError ||
        err instanceof InvalidProjectError
      ) {
        json(res, { error: (err as Error).message }, 400)
        return true
      }
      throw err
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  if (kanbanCardMatch && method === 'DELETE') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    try {
      if (deleteCard(id)) { json(res, { ok: true }); return true }
    } catch (err) {
      if (err instanceof HasActiveChildrenError) { json(res, { error: err.message }, 409); return true }
      throw err
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  // Intake risk-triage enrichment (card c81ce4bf). The ADVISORY layer (async,
  // opt-in) PATCHes a card's triage fields with an LLM feasibility judgment.
  // NO-AUTO-BUILD (chad obligation c-LOW): this endpoint only writes triage_*
  // columns -- it never dispatches a build, and the advisory consumer must run in
  // a context WITHOUT a build-dispatch tool. Verdict monotonicity (c-MEDIUM) is
  // enforced in patchTriage (TriageWeakenError -> 400), not by prompt discipline.
  const kanbanTriageMatch = path.match(/^\/api\/kanban\/([^/]+)\/triage$/)
  if (kanbanTriageMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanTriageMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    const KNOWN_TRIAGE_FIELDS = new Set(['verdict', 'level', 'track', 'tags', 'reasons'])
    const unknown = Object.keys(data).filter((k) => !KNOWN_TRIAGE_FIELDS.has(k))
    if (unknown.length > 0) {
      json(res, { error: `Unknown fields: ${unknown.join(', ')}`, unknown }, 400)
      return true
    }
    const by = ctx.identity?.agentId ?? 'triage-advisory'
    try {
      if (patchTriage(id, { ...data, by })) { json(res, { ok: true }); return true }
    } catch (err) {
      if (err instanceof TriageWeakenError) { json(res, { error: err.message }, 400); return true }
      throw err
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanMoveMatch = path.match(/^\/api\/kanban\/([^/]+)\/move$/)
  if (kanbanMoveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanMoveMatch[1])
    const body = await readBody(req)
    const { status, sort_order } = JSON.parse(body.toString())
    // Dispatch on in_progress is handled internally by noa-kanban.moveCard()
    // (dispatched_at one-shot guard, fire-and-forget). Do not call legacy dispatch.
    try {
      if (moveCard(id, status, sort_order ?? 1)) {
        json(res, { ok: true })
        return true
      }
    } catch (err) {
      if (
        err instanceof InvalidTransitionError ||
        err instanceof InvalidStatusError ||
        err instanceof InvalidSortOrderError
      ) {
        json(res, { error: (err as Error).message }, 400)
        return true
      }
      throw err
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanArchiveMatch = path.match(/^\/api\/kanban\/([^/]+)\/archive$/)
  if (kanbanArchiveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanArchiveMatch[1])
    if (archiveCard(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanCommentsMatch = path.match(/^\/api\/kanban\/([^/]+)\/comments$/)
  if (kanbanCommentsMatch && method === 'GET') {
    const cardId = decodeURIComponent(kanbanCommentsMatch[1])
    json(res, listComments(cardId))
    return true
  }
  if (kanbanCommentsMatch && method === 'POST') {
    const cardId = decodeURIComponent(kanbanCommentsMatch[1])
    const body = await readBody(req)
    const { author, content } = JSON.parse(body.toString())
    if (!author || !content) { json(res, { error: 'Szerző és tartalom kötelező' }, 400); return true }
    json(res, addComment(cardId, author, content))
    return true
  }

  const breakdownMatch = path.match(/^\/api\/kanban\/([^/]+)\/breakdown$/)
  if (breakdownMatch && method === 'POST') {
    const cardId = decodeURIComponent(breakdownMatch[1])
    const card = getCard(cardId)
    if (!card) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const existing = getChildCards(cardId)
    if (existing.length > 0) { json(res, { error: 'A kártya már rendelkezik subtask-okkal' }, 409); return true }
    try {
      const result = await generateBreakdown(card.title, card.description)
      json(res, { subtasks: result.subtasks })
    } catch (err) {
      logger.error({ err, cardId }, 'Breakdown generation failed')
      json(res, { error: (err as Error).message }, 500)
    }
    return true
  }

  const acceptMatch = path.match(/^\/api\/kanban\/([^/]+)\/breakdown\/accept$/)
  if (acceptMatch && method === 'POST') {
    const parentId = decodeURIComponent(acceptMatch[1])
    const parent = getCard(parentId)
    if (!parent) { json(res, { error: 'Szülő kártya nem található' }, 404); return true }
    const body = await readBody(req)
    const { subtasks } = JSON.parse(body.toString()) as {
      subtasks: Array<{ title: string; description: string; assignee: string | null; priority: string }>
    }
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      json(res, { error: 'Subtask lista kötelező' }, 400)
      return true
    }
    // runInTransaction buffers kanban events and flushes only on commit -- a
    // rolled-back breakdown emits nothing (card 7c7ea226).
    const created = runInTransaction(() => {
      const ids: string[] = []
      for (const st of subtasks) {
        const id = randomUUID().slice(0, 8).toUpperCase()
        createCard({
          id,
          title: st.title,
          description: st.description,
          assignee: st.assignee ?? undefined,
          priority: (st.priority as any) ?? 'normal',
          project: parent.project ?? undefined,
          parent_id: parentId,
          suppressIntake: true,
        })
        ids.push(id)
      }
      addComment(parentId, BOT_NAME, `Auto-breakdown: ${ids.length} subtask létrehozva (${ids.join(', ')})`)
      return ids
    })
    json(res, { ok: true, created })
    return true
  }

  const childrenMatch = path.match(/^\/api\/kanban\/([^/]+)\/children$/)
  if (childrenMatch && method === 'GET') {
    const parentId = decodeURIComponent(childrenMatch[1])
    json(res, getChildCards(parentId))
    return true
  }

  return false
}
