import {
  listMediaItems, getMediaItem, createMediaItem, updateMediaItem, deleteMediaItem,
  listShelves, isMediaType, isMediaStatus,
} from '../../noa-media.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleMedia(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/media' && method === 'GET') {
    const type = url.searchParams.get('type') ?? undefined
    const status = url.searchParams.get('status') ?? undefined
    const shelf = url.searchParams.get('shelf') ?? undefined
    const q = url.searchParams.get('q') ?? undefined
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
    const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined

    if (type && !isMediaType(type)) { json(res, { error: 'Érvénytelen type' }, 400); return true }
    if (status && !isMediaStatus(status)) { json(res, { error: 'Érvénytelen status' }, 400); return true }

    json(res, listMediaItems({
      type: type && isMediaType(type) ? type : undefined,
      status: status && isMediaStatus(status) ? status : undefined,
      shelf,
      q,
      limit,
      offset,
    }))
    return true
  }

  if (path === '/api/media' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    if (!isMediaType(data.type)) { json(res, { error: 'type kötelező (book|game|series|film|anime|other)' }, 400); return true }
    if (typeof data.title !== 'string' || data.title.trim() === '') {
      json(res, { error: 'title kötelező' }, 400); return true
    }
    if (data.status !== undefined && !isMediaStatus(data.status)) {
      json(res, { error: 'Érvénytelen status' }, 400); return true
    }
    if (data.rating !== undefined && data.rating !== null) {
      const r = Number(data.rating)
      if (!Number.isInteger(r) || r < 1 || r > 5) { json(res, { error: 'rating: 1-5 vagy null' }, 400); return true }
    }
    const id = createMediaItem({
      agent_id: typeof data.agent_id === 'string' ? data.agent_id : undefined,
      type: data.type,
      title: data.title as string,
      author: typeof data.author === 'string' ? data.author : null,
      status: isMediaStatus(data.status) ? data.status : undefined,
      rating: data.rating != null ? Number(data.rating) : null,
      notes: typeof data.notes === 'string' ? data.notes : null,
      shelf: typeof data.shelf === 'string' ? data.shelf : null,
    })
    json(res, { ok: true, id })
    return true
  }

  const idMatch = path.match(/^\/api\/media\/([^/]+)$/)

  if (idMatch && method === 'GET') {
    const item = getMediaItem(decodeURIComponent(idMatch[1]))
    if (!item) { json(res, { error: 'Nem található' }, 404); return true }
    json(res, item)
    return true
  }

  if (idMatch && method === 'PUT') {
    const id = decodeURIComponent(idMatch[1])
    const data = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    if (data.type !== undefined && !isMediaType(data.type)) { json(res, { error: 'Érvénytelen type' }, 400); return true }
    if (data.status !== undefined && !isMediaStatus(data.status)) { json(res, { error: 'Érvénytelen status' }, 400); return true }
    if (data.rating !== undefined && data.rating !== null) {
      const r = Number(data.rating)
      if (!Number.isInteger(r) || r < 1 || r > 5) { json(res, { error: 'rating: 1-5 vagy null' }, 400); return true }
    }
    const ok = updateMediaItem(id, {
      type: isMediaType(data.type) ? data.type : undefined,
      title: typeof data.title === 'string' ? data.title : undefined,
      author: 'author' in data ? (typeof data.author === 'string' ? data.author : null) : undefined,
      status: isMediaStatus(data.status) ? data.status : undefined,
      rating: 'rating' in data ? (data.rating != null ? Number(data.rating) : null) : undefined,
      notes: 'notes' in data ? (typeof data.notes === 'string' ? data.notes : null) : undefined,
      shelf: 'shelf' in data ? (typeof data.shelf === 'string' ? data.shelf : null) : undefined,
    })
    if (!ok) { json(res, { error: 'Nem található' }, 404); return true }
    json(res, { ok: true })
    return true
  }

  if (idMatch && method === 'DELETE') {
    const id = decodeURIComponent(idMatch[1])
    if (!deleteMediaItem(id)) { json(res, { error: 'Nem található' }, 404); return true }
    json(res, { ok: true })
    return true
  }

  if (path === '/api/media/shelves' && method === 'GET') {
    json(res, listShelves())
    return true
  }

  return false
}
