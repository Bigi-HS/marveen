import { describe, it, expect } from 'vitest'
import type { FetchLike } from '../mcp/google-oauth.js'
import {
  listFilters,
  createFilter,
  deleteFilter,
  getVacation,
  updateVacation,
  GMAIL_FILTERS_URL,
  GMAIL_VACATION_URL,
} from '../mcp/gmail-settings.js'

function jsonRes(obj: unknown, ok = true, status = 200): any {
  return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) }
}
function capturing(response: any) {
  const calls: Array<{ url: string; method: string; body: any }> = []
  const fn = (async (url: string, init: any) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined })
    return response
  }) as unknown as FetchLike
  return { fn, calls }
}

describe('gmail-settings egress', () => {
  it('targets gmail.googleapis.com only', () => {
    expect(GMAIL_FILTERS_URL.startsWith('https://gmail.googleapis.com/')).toBe(true)
    expect(GMAIL_VACATION_URL.startsWith('https://gmail.googleapis.com/')).toBe(true)
  })
})

describe('listFilters', () => {
  it('returns the existing filter set', async () => {
    const { fn } = capturing(jsonRes({ filter: [{ id: 'f1' }, { id: 'f2' }] }))
    const out = await listFilters('tok', fn)
    expect(out.filters).toHaveLength(2)
    expect(out.filters[0].id).toBe('f1')
  })
  it('returns an empty list when no filters exist', async () => {
    const { fn } = capturing(jsonRes({}))
    const out = await listFilters('tok', fn)
    expect(out).toEqual({ filters: [] })
  })
})

describe('createFilter (guarded)', () => {
  it('POSTs criteria + action and returns the new filter id', async () => {
    const { fn, calls } = capturing(jsonRes({ id: 'f9' }))
    const out = (await createFilter('tok', { criteria: { from: 'spam@x.com' }, action: { addLabelIds: ['TRASH'] } }, fn)) as any
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe(GMAIL_FILTERS_URL)
    expect(calls[0].body).toEqual({ criteria: { from: 'spam@x.com' }, action: { addLabelIds: ['TRASH'] } })
    expect(out.id).toBe('f9')
  })

  it('surfaces a 403 forwarding rejection (scope absent), not silently (F-AC5)', async () => {
    const { fn } = capturing(jsonRes({ error: { code: 403 } }, false, 403))
    const out = (await createFilter('tok', { criteria: { from: 'x@y.com' }, action: { forward: 'evil@z.com' } }, fn)) as any
    expect(out).toEqual({ error: 'forwarding not enabled by scope' })
  })
})

describe('deleteFilter (guarded)', () => {
  it('DELETEs the filter by id', async () => {
    const { fn, calls } = capturing(jsonRes({}, true, 204))
    const out = await deleteFilter('tok', 'f9', fn)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe(`${GMAIL_FILTERS_URL}/f9`)
    expect(out).toEqual({ id: 'f9' })
  })
})

describe('getVacation', () => {
  it('reads the current vacation settings', async () => {
    const { fn, calls } = capturing(jsonRes({ enableAutoReply: false, responseSubject: '', responseBodyPlainText: '' }))
    const out = await getVacation('tok', fn)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe(GMAIL_VACATION_URL)
    expect(out.enableAutoReply).toBe(false)
  })
})

describe('updateVacation (guarded)', () => {
  it('PUTs the new vacation settings', async () => {
    const settings = {
      enableAutoReply: true,
      responseSubject: 'Away',
      responseBodyPlainText: 'Back next week',
    }
    const { fn, calls } = capturing(jsonRes(settings))
    const out = await updateVacation('tok', settings, fn)
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toBe(GMAIL_VACATION_URL)
    expect(calls[0].body).toEqual(settings)
    expect(out.enableAutoReply).toBe(true)
  })
})
