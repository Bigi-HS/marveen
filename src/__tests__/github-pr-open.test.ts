import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  validatePrParams,
  openPullRequest,
  PrRequestError,
  PR_BASE_ALLOWLIST,
} from '../web/github-pr.js'
import { tryHandleGithub } from '../web/routes/github.js'

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

describe('validatePrParams (server-side PR-open input contract, card 5bfe0e1f)', () => {
  it('accepts a minimal valid request and defaults base=develop, body=""', () => {
    const v = validatePrParams({ head: 'eng/feature-x', title: 'My PR' })
    expect(v).toEqual({ ok: true, head: 'eng/feature-x', base: 'develop', title: 'My PR', body: '' })
  })

  it('allows only the base allowlist {develop, main}', () => {
    expect(PR_BASE_ALLOWLIST).toEqual(['develop', 'main'])
    expect((validatePrParams({ head: 'eng/x', title: 't', base: 'main' }) as any).base).toBe('main')
    const bad = validatePrParams({ head: 'eng/x', title: 't', base: 'production' })
    expect(bad.ok).toBe(false)
    expect((validatePrParams({ head: 'eng/x', title: 't', base: 'feature/sneaky' }) as any).ok).toBe(false)
  })

  it('requires a head branch', () => {
    expect(validatePrParams({ title: 't' } as any).ok).toBe(false)
    expect(validatePrParams({ head: '   ', title: 't' }).ok).toBe(false)
  })

  it('rejects a cross-fork head (owner:branch) -- locks the PR to our repo', () => {
    // GitHub accepts head="owner:branch" for fork PRs; we forbid the colon so a
    // caller cannot open a PR from an arbitrary fork through our PAT.
    expect(validatePrParams({ head: 'attacker:main', title: 't' }).ok).toBe(false)
  })

  it('rejects invalid head characters and path-traversal forms', () => {
    expect(validatePrParams({ head: 'eng/x y', title: 't' }).ok).toBe(false)
    expect(validatePrParams({ head: 'eng/$(whoami)', title: 't' }).ok).toBe(false)
    expect(validatePrParams({ head: '../etc', title: 't' }).ok).toBe(false)
  })

  it('requires a non-empty title and caps lengths', () => {
    expect(validatePrParams({ head: 'eng/x', title: '   ' }).ok).toBe(false)
    expect(validatePrParams({ head: 'eng/x', title: 'a'.repeat(257) }).ok).toBe(false)
    expect(validatePrParams({ head: 'eng/x', title: 't', body: 'b'.repeat(65537) }).ok).toBe(false)
  })

  it('trims head and title', () => {
    const v = validatePrParams({ head: '  eng/x  ', title: '  hi  ' })
    expect(v).toMatchObject({ ok: true, head: 'eng/x', title: 'hi' })
  })
})

describe('openPullRequest (server-side, dependency-injected)', () => {
  const ok = { head: 'eng/feature-x', base: 'develop', title: 'Title', body: 'Body' }

  it('POSTs to the fixed repo pulls endpoint with the PAT in the Authorization header', async () => {
    const f = fakeFetch({ ok: true, status: 201, json: async () => ({ number: 42, html_url: 'https://github.com/Bigi-HS/marveen/pull/42' }) })
    const res = await openPullRequest(ok, { fetchImpl: f.fn, readToken: () => SECRET })

    expect(res).toEqual({ number: 42, htmlUrl: 'https://github.com/Bigi-HS/marveen/pull/42', head: 'eng/feature-x', base: 'develop' })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].url).toBe('https://api.github.com/repos/Bigi-HS/marveen/pulls')
    expect(f.calls[0].init.method).toBe('POST')
    expect(f.calls[0].init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ head: 'eng/feature-x', base: 'develop', title: 'Title', body: 'Body' })
  })

  it('NEVER leaks the PAT into the result', async () => {
    const f = fakeFetch({ ok: true, status: 201, json: async () => ({ number: 1, html_url: 'https://github.com/Bigi-HS/marveen/pull/1' }) })
    const res = await openPullRequest(ok, { fetchImpl: f.fn, readToken: () => SECRET })
    expect(JSON.stringify(res)).not.toContain(SECRET)
  })

  it('does not call the network when validation fails (fail before egress)', async () => {
    const f = fakeFetch({ ok: true, status: 201 })
    await expect(openPullRequest({ head: 'bad:head', title: 't' }, { fetchImpl: f.fn, readToken: () => SECRET }))
      .rejects.toMatchObject({ status: 400 })
    expect(f.calls).toHaveLength(0)
  })

  it('maps a 422 (e.g. PR already exists) to a 422 PrRequestError with a sanitized message', async () => {
    const f = fakeFetch({ ok: false, status: 422, json: async () => ({ message: 'A pull request already exists for eng/feature-x.' }) })
    await expect(openPullRequest(ok, { fetchImpl: f.fn, readToken: () => SECRET }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining('already exists') })
  })

  it('masks GitHub auth/permission errors as 502 and never leaks the token', async () => {
    const f = fakeFetch({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) })
    let err: any
    try {
      await openPullRequest(ok, { fetchImpl: f.fn, readToken: () => SECRET })
    } catch (e) { err = e }
    expect(err).toBeInstanceOf(PrRequestError)
    expect(err.status).toBe(502)
    expect(JSON.stringify({ m: err.message })).not.toContain(SECRET)
  })

  it('treats a malformed success body as a 502 rather than returning garbage', async () => {
    const f = fakeFetch({ ok: true, status: 201, json: async () => ({ nope: true }) })
    await expect(openPullRequest(ok, { fetchImpl: f.fn, readToken: () => SECRET }))
      .rejects.toMatchObject({ status: 502 })
  })
})

describe('tryHandleGithub route (POST /api/github/pr)', () => {
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

  it('ignores non-matching path/method (returns false)', async () => {
    const rr = makeReqRes('{}')
    const handled = await tryHandleGithub({ req: rr.req, res: rr.res, path: '/api/other', method: 'POST', url: new URL('http://x/api/other'), identity } as any)
    expect(handled).toBe(false)
  })

  it('returns 400 on invalid JSON without making any network call', async () => {
    const rr = makeReqRes('{not json')
    const handled = await tryHandleGithub({ req: rr.req, res: rr.res, path: '/api/github/pr', method: 'POST', url: new URL('http://x/api/github/pr'), identity } as any)
    expect(handled).toBe(true)
    expect(rr.status).toBe(400)
  })

  it('returns 400 on a validation failure (bad head) -- no egress', async () => {
    const rr = makeReqRes(JSON.stringify({ head: 'attacker:main', title: 't' }))
    const handled = await tryHandleGithub({ req: rr.req, res: rr.res, path: '/api/github/pr', method: 'POST', url: new URL('http://x/api/github/pr'), identity } as any)
    expect(handled).toBe(true)
    expect(rr.status).toBe(400)
  })
})

describe('web.ts wiring (github route registered under the auth gate)', () => {
  const WEB_SRC = readFileSync(join(__dirname, '../web.ts'), 'utf-8')
  it('imports and dispatches tryHandleGithub', () => {
    expect(WEB_SRC).toMatch(/import \{ tryHandleGithub \} from '\.\/web\/routes\/github\.js'/)
    expect(WEB_SRC).toMatch(/if \(await tryHandleGithub\(routeCtx\)\) return/)
  })
  it('the dispatch sits after the /api/ auth gate (so identity is resolved/401 enforced)', () => {
    const gateIdx = WEB_SRC.indexOf("path.startsWith('/api/') && !isPublicApi")
    const dispatchIdx = WEB_SRC.indexOf('tryHandleGithub(routeCtx)')
    expect(gateIdx).toBeGreaterThan(0)
    expect(dispatchIdx).toBeGreaterThan(gateIdx)
  })
})
