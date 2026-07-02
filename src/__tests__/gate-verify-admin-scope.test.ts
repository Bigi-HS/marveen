// MG-SEC6 (card 747d60bd): GET /api/gate/verify requires ADMIN_SCOPE.
// Per-agent tokens expose full fleet topology (sessions, watchdogs, vault ids) --
// non-admin callers must get 403 before the verify runs.

import { describe, it, expect } from 'vitest'
import { tryHandleGate } from '../web/routes/gate.js'
import { __setDeployVerifyDeps, __resetDeployVerifyDeps } from '../web/deploy-verify.js'
import type { DeployVerifyDeps } from '../web/deploy-verify.js'

const HEALTHY_DEPS: DeployVerifyDeps = {
  isSessionAlive: () => true,
  isPgrepMatch: () => true,
  listAgents: () => ['dave'],
  hasChannel: () => false,
  isChannelIntentional: () => true,
  getChannelProvider: () => null,
  getVaultSecret: () => 'TOKEN',
  isDbAccessible: () => true,
}

function makeCtx(identity: { agentId: string; scopes: string[]; source: 'operator' | 'agent' } | undefined) {
  const path = '/api/gate/verify'
  const url = new URL(`http://localhost:3420${path}`)
  let responseStatus = 200
  let responseBody = ''
  const res = {
    writeHead: (s: number) => { responseStatus = s },
    end: (b?: string) => { responseBody = b || '' },
  }
  return {
    ctx: { req: {} as any, res: res as any, path, method: 'GET', url, identity },
    getResponse: () => ({ status: responseStatus, body: responseBody ? JSON.parse(responseBody) : null }),
  }
}

describe('GET /api/gate/verify -- MG-SEC6 ADMIN_SCOPE guard', () => {
  it('allows operator identity (source=operator)', async () => {
    __setDeployVerifyDeps(HEALTHY_DEPS)
    try {
      const { ctx, getResponse } = makeCtx({ agentId: 'marveen', scopes: ['admin:*'], source: 'operator' })
      await tryHandleGate(ctx as any)
      const r = getResponse()
      expect(r.status).not.toBe(403)
      expect(r.body).toHaveProperty('pass')
    } finally {
      __resetDeployVerifyDeps()
    }
  })

  it('allows admin-scoped agent token', async () => {
    __setDeployVerifyDeps(HEALTHY_DEPS)
    try {
      const { ctx, getResponse } = makeCtx({ agentId: 'forge', scopes: ['admin:*'], source: 'agent' })
      await tryHandleGate(ctx as any)
      const r = getResponse()
      expect(r.status).not.toBe(403)
      expect(r.body).toHaveProperty('pass')
    } finally {
      __resetDeployVerifyDeps()
    }
  })

  it('blocks per-agent token without admin scope (403)', async () => {
    const { ctx, getResponse } = makeCtx({ agentId: 'dave', scopes: ['memory:write', 'message:send'], source: 'agent' })
    await tryHandleGate(ctx as any)
    const r = getResponse()
    expect(r.status).toBe(403)
    expect(r.body?.error).toMatch(/admin scope/)
  })

  it('allows absent identity (unit-test / no auth middleware)', async () => {
    __setDeployVerifyDeps(HEALTHY_DEPS)
    try {
      const { ctx, getResponse } = makeCtx(undefined)
      await tryHandleGate(ctx as any)
      const r = getResponse()
      expect(r.status).not.toBe(403)
      expect(r.body).toHaveProperty('pass')
    } finally {
      __resetDeployVerifyDeps()
    }
  })
})
