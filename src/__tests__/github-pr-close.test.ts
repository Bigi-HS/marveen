import { describe, it, expect, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import {
  validateClosePrParams,
  closePullRequest,
  PrRequestError,
} from '../web/github-pr.js'
import { tryHandleGithub, __setGithubMergeDeps, __resetGithubMergeDeps } from '../web/routes/github.js'

const SECRET = 'SUPERSECRET_TOKEN_deadbeefdeadbeefdeadbeefdeadbeef'

// A fake fetch that records its call and returns a canned Response-like object.
function fakeFetch(response: { ok: boolean; status: number; json?: () => Promise<any> }) {
  const calls: Array<{ url: string; init: any }> = []
  const fn = (async (url: string, init: any) => {
    calls.push({ url, init })
    return { ok: response.ok, status: response.status, json: response.json ?? (async () => ({})) }
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('validateClosePrParams (server-side PR-close input contract, card 58f79330)', () => {
  it('accepts a positive integer pr_number', () => {
    expect(validateClosePrParams({ pr: 645 })).toEqual({ ok: true, pr: 645 })
  })

  it('rejects zero, negative, non-integer, and missing', () => {
    expect(validateClosePrParams({ pr: 0 }).ok).toBe(false)
    expect(validateClosePrParams({ pr: -1 }).ok).toBe(false)
    expect(validateClosePrParams({ pr: 1.5 }).ok).toBe(false)
    expect(validateClosePrParams({}).ok).toBe(false)
    expect(validateClosePrParams({ pr: '5' as any }).ok).toBe(false)
  })
})

describe('closePullRequest (server-side, dependency-injected)', () => {
  it('PATCHes the fixed repo pulls/<pr> endpoint with state=closed and the PAT header', async () => {
    const f = fakeFetch({ ok: true, status: 200, json: async () => ({ number: 645, state: 'closed' }) })
    const res = await closePullRequest(645, { fetchImpl: f.fn, readToken: () => SECRET })

    expect(res).toEqual({ number: 645, state: 'closed' })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].url).toBe('https://api.github.com/repos/Bigi-HS/marveen/pulls/645')
    expect(f.calls[0].init.method).toBe('PATCH')
    expect(f.calls[0].init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ state: 'closed' })
  })

  it('NEVER leaks the PAT into the result', async () => {
    const f = fakeFetch({ ok: true, status: 200, json: async () => ({ number: 1, state: 'closed' }) })
    const res = await closePullRequest(1, { fetchImpl: f.fn, readToken: () => SECRET })
    expect(JSON.stringify(res)).not.toContain(SECRET)
  })

  it('does not call the network when pr_number is invalid (fail before egress)', async () => {
    const f = fakeFetch({ ok: true, status: 200 })
    await expect(closePullRequest(0, { fetchImpl: f.fn, readToken: () => SECRET }))
      .rejects.toMatchObject({ status: 400 })
    expect(f.calls).toHaveLength(0)
  })

  it('maps a 404 (unknown PR) to a 404 PrRequestError with a sanitized message', async () => {
    const f = fakeFetch({ ok: false, status: 404, json: async () => ({ message: 'Not Found' }) })
    await expect(closePullRequest(999999, { fetchImpl: f.fn, readToken: () => SECRET }))
      .rejects.toMatchObject({ status: 404, message: expect.stringContaining('Not Found') })
  })

  it('masks GitHub auth/permission errors as 502 and never leaks the token', async () => {
    const f = fakeFetch({ ok: false, status: 403, json: async () => ({ message: 'Bad credentials' }) })
    let err: any
    try {
      await closePullRequest(5, { fetchImpl: f.fn, readToken: () => SECRET })
    } catch (e) { err = e }
    expect(err).toBeInstanceOf(PrRequestError)
    expect(err.status).toBe(502)
    expect(JSON.stringify({ m: err.message })).not.toContain(SECRET)
  })

  it('treats a malformed success body as a 502 rather than returning garbage', async () => {
    const f = fakeFetch({ ok: true, status: 200, json: async () => ({ nope: true }) })
    await expect(closePullRequest(5, { fetchImpl: f.fn, readToken: () => SECRET }))
      .rejects.toMatchObject({ status: 502 })
  })
})

describe('tryHandleGithub route (POST /api/github/pr/close)', () => {
  afterEach(() => __resetGithubMergeDeps())

  function makeReqRes(payload: string) {
    const req = Readable.from([Buffer.from(payload)]) as any
    let status = 0
    let body = ''
    const res = {
      writeHead(s: number) { status = s },
      end(b?: string) { body = b ?? '' },
      setHeader() {},
    } as any
    return { req, res, get status() { return status }, get body() { return body ? JSON.parse(body) : null } }
  }
  const identity = { agentId: 'dave', scopes: ['message:send'], source: 'agent' as const }

  it('returns 400 on invalid JSON without any network call', async () => {
    const rr = makeReqRes('{not json')
    const handled = await tryHandleGithub({ req: rr.req, res: rr.res, path: '/api/github/pr/close', method: 'POST', url: new URL('http://x/api/github/pr/close'), identity } as any)
    expect(handled).toBe(true)
    expect(rr.status).toBe(400)
  })

  it('returns 400 on a non-positive pr_number -- no egress', async () => {
    const rr = makeReqRes(JSON.stringify({ pr_number: 0 }))
    const handled = await tryHandleGithub({ req: rr.req, res: rr.res, path: '/api/github/pr/close', method: 'POST', url: new URL('http://x/api/github/pr/close'), identity } as any)
    expect(handled).toBe(true)
    expect(rr.status).toBe(400)
  })

  it('closes via the injected runner and returns 200 {closed:true}', async () => {
    __setGithubMergeDeps({ close: async (pr: number) => ({ number: pr, state: 'closed' }) })
    const rr = makeReqRes(JSON.stringify({ pr_number: 645 }))
    const handled = await tryHandleGithub({ req: rr.req, res: rr.res, path: '/api/github/pr/close', method: 'POST', url: new URL('http://x/api/github/pr/close'), identity } as any)
    expect(handled).toBe(true)
    expect(rr.status).toBe(200)
    expect(rr.body).toEqual({ closed: true, number: 645, state: 'closed' })
  })

  it('surfaces a PrRequestError status from the runner (e.g. 404)', async () => {
    __setGithubMergeDeps({ close: async () => { throw new PrRequestError(404, 'Not Found') } })
    const rr = makeReqRes(JSON.stringify({ pr_number: 999999 }))
    const handled = await tryHandleGithub({ req: rr.req, res: rr.res, path: '/api/github/pr/close', method: 'POST', url: new URL('http://x/api/github/pr/close'), identity } as any)
    expect(handled).toBe(true)
    expect(rr.status).toBe(404)
  })

  it('ignores a non-matching path (returns false)', async () => {
    const rr = makeReqRes('{}')
    const handled = await tryHandleGithub({ req: rr.req, res: rr.res, path: '/api/other', method: 'POST', url: new URL('http://x/api/other'), identity } as any)
    expect(handled).toBe(false)
  })
})
