import { describe, it, expect } from 'vitest'
import type { FetchLike } from '../mcp/google-oauth.js'
import {
  listLabels,
  createLabel,
  updateLabel,
  deleteLabel,
  isSystemLabel,
  GMAIL_LABELS_URL,
} from '../mcp/gmail-labels.js'

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
const neverFetch = (async () => {
  throw new Error('fetch must not be called')
}) as unknown as FetchLike

describe('gmail-labels egress', () => {
  it('targets gmail.googleapis.com only', () => {
    expect(GMAIL_LABELS_URL.startsWith('https://gmail.googleapis.com/')).toBe(true)
  })
})

describe('isSystemLabel', () => {
  it('flags reserved system label ids', () => {
    expect(isSystemLabel('INBOX')).toBe(true)
    expect(isSystemLabel('SENT')).toBe(true)
    expect(isSystemLabel('TRASH')).toBe(true)
    expect(isSystemLabel('SPAM')).toBe(true)
    expect(isSystemLabel('CATEGORY_PROMOTIONS')).toBe(true)
  })
  it('treats user label ids as non-system', () => {
    expect(isSystemLabel('Label_42')).toBe(false)
    expect(isSystemLabel('Label_personal')).toBe(false)
  })
})

describe('listLabels', () => {
  it('returns the label definitions', async () => {
    const { fn } = capturing(jsonRes({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Work', type: 'user' }] }))
    const out = await listLabels('tok', fn)
    expect(out.labels).toHaveLength(2)
    expect(out.labels[1]).toEqual({ id: 'Label_1', name: 'Work', type: 'user' })
  })
})

describe('createLabel', () => {
  it('POSTs the new label name', async () => {
    const { fn, calls } = capturing(jsonRes({ id: 'Label_9', name: 'Receipts', type: 'user' }))
    const out = await createLabel('tok', { name: 'Receipts' }, fn)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe(GMAIL_LABELS_URL)
    expect(calls[0].body).toEqual({ name: 'Receipts' })
    expect(out.id).toBe('Label_9')
  })
})

describe('updateLabel', () => {
  it('PATCHes the label fields', async () => {
    const { fn, calls } = capturing(jsonRes({ id: 'Label_9', name: 'Bills', type: 'user' }))
    const out = await updateLabel('tok', 'Label_9', { name: 'Bills' }, fn)
    expect(calls[0].method).toBe('PATCH')
    expect(calls[0].url).toBe(`${GMAIL_LABELS_URL}/Label_9`)
    expect(calls[0].body).toEqual({ name: 'Bills' })
    expect(out.name).toBe('Bills')
  })
})

describe('deleteLabel (guarded)', () => {
  it('rejects a system label BEFORE any API call', async () => {
    const out = (await deleteLabel('tok', 'INBOX', neverFetch)) as any
    expect(out).toEqual({ error: 'system labels cannot be deleted' })
  })
  it('DELETEs a user label', async () => {
    const { fn, calls } = capturing(jsonRes({}, true, 204))
    const out = (await deleteLabel('tok', 'Label_9', fn)) as any
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe(`${GMAIL_LABELS_URL}/Label_9`)
    expect(out).toEqual({ id: 'Label_9' })
  })
})
