import { randomUUID } from 'node:crypto'
import {
  listCards, listArchived, createCard, updateCard, deleteCard, moveCard, archiveCard,
  listComments, addComment, listProjects, getCard, getChildCards, runInTransaction,
  InvalidTransitionError, InvalidStatusError, InvalidSortOrderError, HasActiveChildrenError,
  ParentNotFoundError,
} from '../../noa-kanban.js'
import { OWNER_NAME, BOT_NAME } from '../../config.js'
import { listAgentNames, readAgentDisplayName, findAvatarForAgent } from '../agent-config.js'
import { generateBreakdown } from '../llm-breakdown.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

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
  const { req, res, path, method } = ctx

  if (path === '/api/kanban' && method === 'GET') {
    json(res, listCards())
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
      createCard({ id, ...data })
    } catch (err) {
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
    try {
      if (updateCard(id, data)) { json(res, { ok: true }); return true }
    } catch (err) {
      if (err instanceof InvalidTransitionError || err instanceof InvalidStatusError) {
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
