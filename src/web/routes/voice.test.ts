import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tryHandleVoice, __setTranscriber } from './voice.js'
import type { RouteContext } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  path: string,
  method: string,
  body: unknown,
  agentId = 'test-agent',
): RouteContext {
  const bodyStr = JSON.stringify(body)
  const chunks: Buffer[] = [Buffer.from(bodyStr)]
  const req = {
    on(event: string, cb: (data?: Buffer) => void) {
      if (event === 'data') chunks.forEach((c) => cb(c))
      if (event === 'end') cb()
      return req
    },
  } as any

  const responseData: { status?: number; body?: unknown } = {}
  const res = {
    writeHead: (status: number) => { responseData.status = status },
    end: (data: string) => {
      try { responseData.body = JSON.parse(data) } catch { responseData.body = data }
    },
  } as any

  const ctx: RouteContext = {
    req,
    res,
    path,
    method,
    url: new URL(`http://dummy${path}`),
    identity: { agentId } as any,
  }
  ;(ctx as any)._responseData = responseData
  return ctx
}

function getResponse(ctx: RouteContext): { status?: number; body?: unknown } {
  return (ctx as any)._responseData
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/voice/transcribe', () => {
  beforeEach(() => {
    __setTranscriber(async (_buf, _mime) => 'hello world')
  })

  afterEach(() => {
    __setTranscriber(null)
  })

  it('returns false for non-voice paths', async () => {
    const ctx = makeCtx('/api/workout/plan', 'GET', {})
    const handled = await tryHandleVoice(ctx)
    expect(handled).toBe(false)
  })

  it('returns false for non-matching voice sub-path', async () => {
    const ctx = makeCtx('/api/voice/unknown', 'POST', {})
    const handled = await tryHandleVoice(ctx)
    expect(handled).toBe(false)
  })

  it('returns 403 without identity', async () => {
    const ctx = makeCtx('/api/voice/transcribe', 'POST', {})
    ;(ctx as any).identity = undefined
    const handled = await tryHandleVoice(ctx)
    expect(handled).toBe(true)
    const resp = getResponse(ctx)
    expect(resp.status).toBe(403)
    expect((resp.body as any).ok).toBe(false)
  })

  it('returns 400 for invalid JSON body', async () => {
    // override req with malformed JSON
    const req = {
      on(event: string, cb: (data?: Buffer) => void) {
        if (event === 'data') cb(Buffer.from('not-json'))
        if (event === 'end') cb()
        return req
      },
    } as any
    const responseData: { status?: number; body?: unknown } = {}
    const res = {
      writeHead: (s: number) => { responseData.status = s },
      end: (d: string) => { responseData.body = JSON.parse(d) },
    } as any
    const ctx: RouteContext = {
      req, res,
      path: '/api/voice/transcribe',
      method: 'POST',
      url: new URL('http://dummy/api/voice/transcribe'),
      identity: { agentId: 'test' } as any,
    }
    const handled = await tryHandleVoice(ctx)
    expect(handled).toBe(true)
    expect(responseData.status).toBe(400)
    expect((responseData.body as any).ok).toBe(false)
  })

  it('returns 400 when audioBase64 is missing', async () => {
    const ctx = makeCtx('/api/voice/transcribe', 'POST', { mimeType: 'audio/webm' })
    const handled = await tryHandleVoice(ctx)
    expect(handled).toBe(true)
    const resp = getResponse(ctx)
    expect(resp.status).toBe(400)
    expect((resp.body as any).ok).toBe(false)
  })

  it('returns 400 for empty audio buffer', async () => {
    const ctx = makeCtx('/api/voice/transcribe', 'POST', {
      audioBase64: Buffer.from('').toString('base64'),
      mimeType: 'audio/webm',
    })
    const handled = await tryHandleVoice(ctx)
    expect(handled).toBe(true)
    const resp = getResponse(ctx)
    expect(resp.status).toBe(400)
    expect((resp.body as any).ok).toBe(false)
  })

  it('transcribes audio and returns text', async () => {
    const fakeAudio = Buffer.from('fake-audio-data')
    const ctx = makeCtx('/api/voice/transcribe', 'POST', {
      audioBase64: fakeAudio.toString('base64'),
      mimeType: 'audio/webm',
    })
    const handled = await tryHandleVoice(ctx)
    expect(handled).toBe(true)
    const resp = getResponse(ctx)
    // json() calls writeHead(200) for success
    expect(resp.status).toBe(200)
    expect((resp.body as any).ok).toBe(true)
    expect((resp.body as any).text).toBe('hello world')
  })

  it('returns ok:false when transcriber throws', async () => {
    __setTranscriber(async () => { throw new Error('transcription failed') })
    const fakeAudio = Buffer.from('fake-audio-data')
    const ctx = makeCtx('/api/voice/transcribe', 'POST', {
      audioBase64: fakeAudio.toString('base64'),
      mimeType: 'audio/webm',
    })
    const handled = await tryHandleVoice(ctx)
    expect(handled).toBe(true)
    const resp = getResponse(ctx)
    expect(resp.status).toBe(500)
    expect((resp.body as any).ok).toBe(false)
  })
})
