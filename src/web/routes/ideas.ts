import { randomUUID } from 'node:crypto'
import { listIdeas, createIdea, updateIdea, deleteIdea, listIdeaCategories, getDb } from '../../db.js'
import { createCard } from '../../noa-kanban.js'
import { generateBreakdown } from '../llm-breakdown.js'
import { parseScore } from '../idea-scoring.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

type IdeaRow = import('../../db.js').IdeaBoxRow

function getIdea(id: string): IdeaRow | undefined {
  return getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(id) as IdeaRow | undefined
}

const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])

export async function tryHandleIdeas(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/ideas' && method === 'GET') {
    const status = url.searchParams.get('status') || undefined
    const category = url.searchParams.get('category') || undefined
    json(res, listIdeas({ status, category }))
    return true
  }

  if (path === '/api/ideas/categories' && method === 'GET') {
    json(res, listIdeaCategories())
    return true
  }

  if (path === '/api/ideas' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      title: string
      description?: string
      category?: string
      source?: string
      impact?: unknown
      effort?: unknown
    }
    if (!data.title) { json(res, { error: 'title required' }, 400); return true }
    const impact = parseScore(data.impact)
    const effort = parseScore(data.effort)
    if (!impact.ok || !effort.ok) { json(res, { error: 'impact/effort must be an integer 1-5 or null' }, 400); return true }
    const id = randomUUID().slice(0, 8)
    createIdea({
      id,
      title: data.title,
      description: data.description ?? null,
      category: data.category ?? 'Egyéb',
      status: 'new',
      source: data.source ?? 'manual',
      kanban_id: null,
      impact: impact.value,
      effort: effort.value,
    })
    json(res, { ok: true, id })
    return true
  }

  const ideaMatch = path.match(/^\/api\/ideas\/([^/]+)$/)

  if (ideaMatch && method === 'PUT') {
    const id = decodeURIComponent(ideaMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as Record<string, unknown>
    // Validate the scoring fields when present; only override the raw values once
    // parsed so an out-of-range score is rejected rather than persisted.
    if ('impact' in data) {
      const p = parseScore(data.impact)
      if (!p.ok) { json(res, { error: 'impact must be an integer 1-5 or null' }, 400); return true }
      data.impact = p.value
    }
    if ('effort' in data) {
      const p = parseScore(data.effort)
      if (!p.ok) { json(res, { error: 'effort must be an integer 1-5 or null' }, 400); return true }
      data.effort = p.value
    }
    if (updateIdea(id, data)) { json(res, { ok: true }); return true }
    json(res, { error: 'Ötlet nem található' }, 404)
    return true
  }

  if (ideaMatch && method === 'DELETE') {
    const id = decodeURIComponent(ideaMatch[1])
    if (deleteIdea(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Ötlet nem található' }, 404)
    return true
  }

  // Promote idea to kanban card
  const promoteMatch = path.match(/^\/api\/ideas\/([^/]+)\/promote$/)
  if (promoteMatch && method === 'POST') {
    const ideaId = decodeURIComponent(promoteMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { phase?: 'detail' | 'plan' }
    const phase = data.phase ?? 'detail'

    const idea = (getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(ideaId) as import('../../db.js').IdeaBoxRow | undefined)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }

    const cardId = randomUUID().slice(0, 8)
    const status = phase === 'plan' ? 'planned' : 'waiting'
    const title = phase === 'plan' ? idea.title : `[Részlet kidolgozás] ${idea.title}`
    createCard({
      id: cardId,
      title,
      description: idea.description ?? '',
      status,
      priority: 'normal',
      assignee: 'marveen',
      project: 'ENG', // canonical taxonomy (card cf0d1bfe); promoted ideas default to ENG, re-prefix via updateCard if they belong elsewhere
    })
    updateIdea(ideaId, { status: 'kanban', kanban_id: cardId })
    json(res, { ok: true, kanban_id: cardId })
    return true
  }

  // AI breakdown: elaborate the idea into 3-5 assignable subtasks (no DB write
  // yet -- the user approves per-subtask in the UI, then calls promote-breakdown).
  const breakdownMatch = path.match(/^\/api\/ideas\/([^/]+)\/breakdown$/)
  if (breakdownMatch && method === 'POST') {
    const ideaId = decodeURIComponent(breakdownMatch[1])
    const idea = getIdea(ideaId)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    try {
      const result = await generateBreakdown(idea.title, idea.description)
      json(res, { subtasks: result.subtasks })
    } catch (err) {
      logger.error({ err, ideaId }, 'Idea breakdown generation failed')
      json(res, { error: (err as Error).message }, 500)
    }
    return true
  }

  // Promote an idea via approved breakdown: create a parent card from the idea +
  // one child card per approved subtask (assignee + priority), mark idea 'kanban'.
  const promoteBreakdownMatch = path.match(/^\/api\/ideas\/([^/]+)\/promote-breakdown$/)
  if (promoteBreakdownMatch && method === 'POST') {
    const ideaId = decodeURIComponent(promoteBreakdownMatch[1])
    const idea = getIdea(ideaId)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    const body = await readBody(req)
    const { subtasks } = JSON.parse(body.toString()) as {
      subtasks: Array<{ title: string; description?: string; assignee?: string | null; priority?: string }>
    }
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      json(res, { error: 'Legalább egy jóváhagyott alfeladat kötelező' }, 400)
      return true
    }
    const parentId = randomUUID().slice(0, 8)
    createCard({
      id: parentId,
      title: idea.title,
      description: idea.description ?? '',
      status: 'planned',
      priority: 'normal',
      assignee: 'marveen',
      project: 'ENG', // canonical taxonomy (card cf0d1bfe); promoted ideas default to ENG, re-prefix via updateCard if they belong elsewhere
    })
    const childIds: string[] = []
    for (const st of subtasks) {
      if (!st.title) continue
      const childId = randomUUID().slice(0, 8)
      createCard({
        id: childId,
        title: String(st.title).slice(0, 120),
        description: (st.description ?? '').slice(0, 500),
        status: 'planned',
        priority: (st.priority && VALID_PRIORITIES.has(st.priority) ? st.priority : 'normal') as 'low' | 'normal' | 'high' | 'urgent',
        assignee: st.assignee || 'marveen',
        project: 'ENG', // canonical taxonomy (card cf0d1bfe); promoted ideas default to ENG, re-prefix via updateCard if they belong elsewhere
        parent_id: parentId,
      })
      childIds.push(childId)
    }
    updateIdea(ideaId, { status: 'kanban', kanban_id: parentId })
    json(res, { ok: true, parent_id: parentId, child_count: childIds.length })
    return true
  }

  return false
}
