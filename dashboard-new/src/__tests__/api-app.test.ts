import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchWorkoutPlan,
  fetchCalendarToday,
  fetchJournalEntries,
  apiPost,
  postJournalEntry,
  postWorkoutCheckin,
  markTodoDone,
} from '@/lib/api-app'

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  })
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('fetchWorkoutPlan', () => {
  it('returns plan on 200', async () => {
    const plan = { date: '2026-11-09', exercises: [{ name: 'Squat', sets: 3, reps: 10, weight: 80, unit: 'kg' }], notes: '' }
    vi.stubGlobal('fetch', mockFetch(200, plan))
    const result = await fetchWorkoutPlan()
    expect(result).toEqual(plan)
    expect(fetch).toHaveBeenCalledWith('/api/workout/plan', expect.objectContaining({ method: 'GET' }))
  })

  it('returns null on 503 (calendar unavailable)', async () => {
    vi.stubGlobal('fetch', mockFetch(503, { error: 'unavailable' }))
    expect(await fetchWorkoutPlan()).toBeNull()
  })
})

describe('fetchCalendarToday', () => {
  it('returns events array on 200', async () => {
    const events = [{ id: '1', summary: 'Standup', start: '10:00', end: '10:30', location: '', description: '' }]
    vi.stubGlobal('fetch', mockFetch(200, { events }))
    const result = await fetchCalendarToday()
    expect(result).toEqual(events)
  })

  it('returns empty array on 503', async () => {
    vi.stubGlobal('fetch', mockFetch(503, { error: 'unavailable' }))
    expect(await fetchCalendarToday()).toEqual([])
  })
})

describe('fetchJournalEntries', () => {
  it('fetches with default limit 5', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { entries: [] }))
    await fetchJournalEntries()
    expect(fetch).toHaveBeenCalledWith('/api/journal/entries?limit=5', expect.anything())
  })

  it('respects custom limit', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { entries: [] }))
    await fetchJournalEntries(1)
    expect(fetch).toHaveBeenCalledWith('/api/journal/entries?limit=1', expect.anything())
  })

  it('returns entries array', async () => {
    const entries = [{ id: 1, content: 'Good day', mood: 'happy', tags: null, createdAt: '2026-11-09' }]
    vi.stubGlobal('fetch', mockFetch(200, { entries }))
    expect(await fetchJournalEntries()).toEqual(entries)
  })
})

describe('apiPost', () => {
  it('sends POST with JSON body and auth header', async () => {
    localStorage.setItem('noa-api-token', 'tok-test')
    vi.stubGlobal('fetch', mockFetch(200, { ok: true }))
    const result = await apiPost('/api/journal/entries', { content: 'test' })
    expect(result).toEqual({ ok: true })
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('/api/journal/entries')
    expect(call[1].method).toBe('POST')
    expect(call[1].headers['Authorization']).toBe('Bearer tok-test')
    expect(JSON.parse(call[1].body as string)).toEqual({ content: 'test' })
  })

  it('throws ApiError on non-2xx', async () => {
    vi.stubGlobal('fetch', mockFetch(400, { error: 'bad request' }))
    await expect(apiPost('/api/journal/entries', {})).rejects.toThrow('400')
  })
})

describe('postJournalEntry', () => {
  it('posts content + mood + tags', async () => {
    vi.stubGlobal('fetch', mockFetch(201, { id: 42 }))
    const result = await postJournalEntry('Great day', 'happy', 'workout,food')
    expect(result).toEqual({ id: 42 })
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
    expect(body).toEqual({ content: 'Great day', mood: 'happy', tags: 'workout,food' })
  })

  it('posts content-only (optional fields omitted)', async () => {
    vi.stubGlobal('fetch', mockFetch(201, { id: 7 }))
    await postJournalEntry('Quiet day')
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
    expect(body).toEqual({ content: 'Quiet day' })
  })
})

describe('postWorkoutCheckin', () => {
  it('posts note to workout checkin endpoint', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { sent: true }))
    const result = await postWorkoutCheckin('Done: 3x10 squat 80kg')
    expect(result).toEqual({ sent: true })
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('/api/workout/checkin')
    const body = JSON.parse(call[1].body as string)
    expect(body.note).toBe('Done: 3x10 squat 80kg')
  })
})

describe('markTodoDone id-guard (SEC-112, #931)', () => {
  it('calls POST /api/todos/{id}/done for a valid alphanum id', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { ok: true }))
    await markTodoDone('abc123')
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/todos/abc123/done')
  })

  it('allows UUIDs (hyphens OK)', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { ok: true }))
    await markTodoDone('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('/api/todos/')
  })

  it('throws without fetch for id with ../ (path traversal)', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(markTodoDone('../secret')).rejects.toThrow('Invalid todo id')
    expect(spy).not.toHaveBeenCalled()
  })

  it('throws without fetch for id with slash', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(markTodoDone('a/b')).rejects.toThrow('Invalid todo id')
    expect(spy).not.toHaveBeenCalled()
  })

  it('throws without fetch for empty id', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(markTodoDone('')).rejects.toThrow('Invalid todo id')
    expect(spy).not.toHaveBeenCalled()
  })
})
