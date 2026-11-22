// Route-integration tests for POST /api/github/branch-protection.
//
// Verifies the route layer's fail-closed contract: only main/develop accepted,
// arbitrary branch rejected 400, network errors masked. Network dependency
// (setBranchProtection) is injected via __setGithubBranchProtectionDeps so the
// route runs fully in-process without a real GitHub call.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import { initDatabase } from '../db.js'
import {
  tryHandleGithub,
  __setGithubBranchProtectionDeps,
  __resetGithubBranchProtectionDeps,
} from '../web/routes/github.js'
import { BranchProtectionError } from '../web/github-branch-protection.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'

const TEST_DB = '/tmp/test-github-branch-protection-route.db'
const operatorId: AgentIdentity = { agentId: 'dave', scopes: ['message:send'], source: 'operator' }

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

function makeCtx(body: string, identity = operatorId) {
  const req = Object.assign(Readable.from([Buffer.from(body)]), { headers: {} })
  const chunks: Buffer[] = []
  let statusCode = 200
  const res = {
    writeHead: (code: number) => { statusCode = code },
    end: (data: string) => { chunks.push(Buffer.from(data)) },
    get statusCode() { return statusCode },
    get body() { return chunks.map((c) => c.toString()).join('') },
  }
  return { req, res, path: '/api/github/branch-protection', method: 'POST', identity } as any
}

beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
})
afterEach(() => {
  __resetGithubBranchProtectionDeps()
  vi.restoreAllMocks()
})
afterAll(() => cleanDb())

describe('POST /api/github/branch-protection route', () => {
  it('returns 200 and applied=true for main', async () => {
    const spy = vi.fn().mockResolvedValue({ branch: 'main', applied: true })
    __setGithubBranchProtectionDeps({ protect: spy })

    const ctx = makeCtx(JSON.stringify({ branch: 'main' }))
    const handled = await tryHandleGithub(ctx)

    expect(handled).toBe(true)
    expect(ctx.res.statusCode).toBe(200)
    const body = JSON.parse(ctx.res.body)
    expect(body.branch).toBe('main')
    expect(body.applied).toBe(true)
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith('main')
  })

  it('returns 200 and applied=true for develop', async () => {
    const spy = vi.fn().mockResolvedValue({ branch: 'develop', applied: true })
    __setGithubBranchProtectionDeps({ protect: spy })

    const ctx = makeCtx(JSON.stringify({ branch: 'develop' }))
    const handled = await tryHandleGithub(ctx)

    expect(handled).toBe(true)
    expect(ctx.res.statusCode).toBe(200)
    expect(spy).toHaveBeenCalledWith('develop')
  })

  it('returns 400 for arbitrary branch (fail-closed)', async () => {
    const spy = vi.fn()
    __setGithubBranchProtectionDeps({ protect: spy })

    const ctx = makeCtx(JSON.stringify({ branch: 'feature/x' }))
    await tryHandleGithub(ctx)

    expect(ctx.res.statusCode).toBe(400)
    expect(spy).not.toHaveBeenCalled()
    const body = JSON.parse(ctx.res.body)
    expect(body.error).toMatch(/allowlist/)
  })

  it('returns 400 for missing branch', async () => {
    const spy = vi.fn()
    __setGithubBranchProtectionDeps({ protect: spy })

    const ctx = makeCtx(JSON.stringify({}))
    await tryHandleGithub(ctx)

    expect(ctx.res.statusCode).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns 400 for invalid JSON body', async () => {
    const spy = vi.fn()
    __setGithubBranchProtectionDeps({ protect: spy })

    const ctx = makeCtx('not-json')
    await tryHandleGithub(ctx)

    expect(ctx.res.statusCode).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('surfaces BranchProtectionError status from protector', async () => {
    const spy = vi.fn().mockRejectedValue(new BranchProtectionError(502, 'GitHub authentication/permission error'))
    __setGithubBranchProtectionDeps({ protect: spy })

    const ctx = makeCtx(JSON.stringify({ branch: 'main' }))
    await tryHandleGithub(ctx)

    expect(ctx.res.statusCode).toBe(502)
    const body = JSON.parse(ctx.res.body)
    expect(body.error).toBe('GitHub authentication/permission error')
  })

  it('returns 500 for unexpected error from protector', async () => {
    const spy = vi.fn().mockRejectedValue(new Error('unexpected'))
    __setGithubBranchProtectionDeps({ protect: spy })

    const ctx = makeCtx(JSON.stringify({ branch: 'main' }))
    await tryHandleGithub(ctx)

    expect(ctx.res.statusCode).toBe(500)
  })

  it('does not handle non-matching paths', async () => {
    const ctx = { ...makeCtx('{}'), path: '/api/github/pr' }
    // PR open requires more data -- just check it does NOT match our route
    const spy = vi.fn()
    __setGithubBranchProtectionDeps({ protect: spy })
    // Don't care about the result, just that our protector wasn't called
    await tryHandleGithub(ctx).catch(() => {})
    expect(spy).not.toHaveBeenCalled()
  })
})
