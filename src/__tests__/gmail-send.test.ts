import { describe, it, expect } from 'vitest'
import { buildRawMessage, sendEmail, GMAIL_SEND_URL } from '../mcp/gmail-send.js'
import type { FetchLike } from '../mcp/google-oauth.js'

function decodeRaw(raw: string): string {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf-8')
}

describe('buildRawMessage', () => {
  it('produces a decodable RFC822 message with To, Subject and body', () => {
    const raw = buildRawMessage({ to: 'a@b.com', subject: 'Hi', body: 'Hello there' })
    const msg = decodeRaw(raw)
    expect(msg).toContain('To: a@b.com')
    expect(msg).toContain('Subject: Hi')
    expect(msg).toMatch(/\r\n\r\nHello there$/)
  })

  it('leaves an ASCII subject unencoded but RFC2047-encodes a non-ASCII one', () => {
    expect(decodeRaw(buildRawMessage({ to: 'a@b.com', subject: 'Plain', body: 'x' })))
      .toContain('Subject: Plain')
    const unicode = decodeRaw(buildRawMessage({ to: 'a@b.com', subject: 'Árvíztűrő', body: 'x' }))
    expect(unicode).toContain('Subject: =?UTF-8?B?')
    expect(unicode).not.toContain('Subject: Árvíztűrő')
  })

  it('includes From and Cc only when provided', () => {
    const withBoth = decodeRaw(
      buildRawMessage({ to: 'a@b.com', cc: 'c@d.com', from: 'me@x.com', subject: 's', body: 'b' }),
    )
    expect(withBoth).toContain('From: me@x.com')
    expect(withBoth).toContain('Cc: c@d.com')
    const minimal = decodeRaw(buildRawMessage({ to: 'a@b.com', subject: 's', body: 'b' }))
    expect(minimal).not.toContain('From:')
    expect(minimal).not.toContain('Cc:')
  })

  it('rejects an empty recipient', () => {
    expect(() => buildRawMessage({ to: '', subject: 's', body: 'b' })).toThrow(/"to" is required/)
    expect(() => buildRawMessage({ to: '   ', subject: 's', body: 'b' })).toThrow()
  })
})

describe('sendEmail', () => {
  it('POSTs the raw message to the Gmail send endpoint with a Bearer token', async () => {
    let seenUrl = ''
    let seenInit: any = null
    const fetchFn: FetchLike = async (url, init) => {
      seenUrl = url
      seenInit = init
      return { ok: true, status: 200, json: async () => ({ id: 'msg123' }), text: async () => '' }
    }
    const id = await sendEmail('TOK', 'RAWDATA', fetchFn)
    expect(id).toBe('msg123')
    expect(seenUrl).toBe(GMAIL_SEND_URL)
    expect(seenInit.method).toBe('POST')
    expect(seenInit.headers.Authorization).toBe('Bearer TOK')
    expect(JSON.parse(seenInit.body)).toEqual({ raw: 'RAWDATA' })
  })

  it('throws on a non-ok response', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: false, status: 403, json: async () => ({}), text: async () => 'forbidden',
    })
    await expect(sendEmail('TOK', 'R', fetchFn)).rejects.toThrow(/gmail send failed: 403/)
  })

  it('throws when the response has no message id', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: true, status: 200, json: async () => ({}), text: async () => '',
    })
    await expect(sendEmail('TOK', 'R', fetchFn)).rejects.toThrow(/no message id/)
  })
})
