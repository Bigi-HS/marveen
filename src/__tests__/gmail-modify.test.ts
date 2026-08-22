import { describe, it, expect } from 'vitest'
import type { FetchLike } from '../mcp/google-oauth.js'
import {
  archiveDelta,
  markReadDelta,
  starDelta,
  labelDelta,
  spamDelta,
  unspamDelta,
  applyToMessages,
  trashMessage,
  moveToInbox,
  BULK_MODIFY_LIMIT,
  LBL_INBOX,
  LBL_UNREAD,
  LBL_STARRED,
  LBL_SPAM,
} from '../mcp/gmail-modify.js'

function jsonRes(obj: unknown, ok = true, status = 200): any {
  return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) }
}

// A fetch stub that records every call so we can assert URL + body.
function capturing(response: any = jsonRes({ id: 'm1' })) {
  const calls: Array<{ url: string; body: any }> = []
  const fn = (async (url: string, init: any) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
    return response
  }) as unknown as FetchLike
  return { fn, calls }
}

// A fetch that fails the test if it is ever called (proves a pre-fetch reject).
const neverFetch = (async () => {
  throw new Error('fetch must not be called')
}) as unknown as FetchLike

// pure label deltas
describe('label deltas', () => {
  it('archive removes INBOX', () => {
    expect(archiveDelta()).toEqual({ remove: [LBL_INBOX] })
  })
  it('mark_read toggles UNREAD', () => {
    expect(markReadDelta(true)).toEqual({ remove: [LBL_UNREAD] })
    expect(markReadDelta(false)).toEqual({ add: [LBL_UNREAD] })
  })
  it('star toggles STARRED', () => {
    expect(starDelta(true)).toEqual({ add: [LBL_STARRED] })
    expect(starDelta(false)).toEqual({ remove: [LBL_STARRED] })
  })
  it('label applies/removes a user label', () => {
    expect(labelDelta('Label_42', true)).toEqual({ add: ['Label_42'] })
    expect(labelDelta('Label_42', false)).toEqual({ remove: ['Label_42'] })
  })
  it('mark_spam adds SPAM + removes INBOX, unmark reverses', () => {
    expect(spamDelta()).toEqual({ add: [LBL_SPAM], remove: [LBL_INBOX] })
    expect(unspamDelta()).toEqual({ add: [LBL_INBOX], remove: [LBL_SPAM] })
  })
})

describe('applyToMessages', () => {
  it('uses the single-message modify endpoint for 1 id', async () => {
    const { fn, calls } = capturing()
    const out = await applyToMessages('tok', ['m1'], archiveDelta(), fn)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify')
    expect(calls[0].body).toEqual({ removeLabelIds: [LBL_INBOX] })
    expect(out).toEqual({ ids: ['m1'] })
  })

  it('uses batchModify for >1 id (within the limit)', async () => {
    const { fn, calls } = capturing(jsonRes({}, true, 204))
    const ids = ['a', 'b', 'c']
    const out = await applyToMessages('tok', ids, markReadDelta(true), fn)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify')
    expect(calls[0].body).toEqual({ ids, removeLabelIds: [LBL_UNREAD] })
    expect(out).toEqual({ ids })
  })

  it('rejects a batch >10 BEFORE any API call (SEC-AC6)', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => 'm' + i)
    await expect(applyToMessages('tok', ids, archiveDelta(), neverFetch)).rejects.toThrow(
      /bulk modify rejected/i,
    )
  })

  it('accepts exactly the limit (10)', async () => {
    const { fn, calls } = capturing(jsonRes({}, true, 204))
    const ids = Array.from({ length: BULK_MODIFY_LIMIT }, (_, i) => 'm' + i)
    await applyToMessages('tok', ids, archiveDelta(), fn)
    expect(calls).toHaveLength(1)
  })

  it('rejects an empty id list', async () => {
    await expect(applyToMessages('tok', [], archiveDelta(), neverFetch)).rejects.toThrow(
      /no messages/i,
    )
  })
})

describe('trashMessage (guarded, single-only)', () => {
  it('hits the dedicated trash endpoint for one id', async () => {
    const { fn, calls } = capturing(jsonRes({ id: 'm5' }))
    const out = await trashMessage('tok', 'm5', fn)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/m5/trash')
    expect(out).toEqual({ id: 'm5' })
  })
})

describe('moveToInbox', () => {
  it('untrashes then restores INBOX and clears SPAM', async () => {
    const { fn, calls } = capturing(jsonRes({ id: 'm7' }))
    await moveToInbox('tok', 'm7', fn)
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/m7/untrash')
    expect(calls[1].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/m7/modify')
    expect(calls[1].body).toEqual({ addLabelIds: [LBL_INBOX], removeLabelIds: [LBL_SPAM] })
  })
})
