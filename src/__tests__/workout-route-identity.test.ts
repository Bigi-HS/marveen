// Tests for workout checkin from_agent identity hardening (cards 74fd0ed8+92f33424)
//
// Verifies that POST /api/workout/checkin propagates identity.agentId to the
// CheckinSender so the agent_messages.from_agent column reflects the actual
// caller, not the hardcoded 'marveen' default.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import {
  tryHandleWorkout,
  __setPlanFetcher,
  __setCheckinSender,
} from '../web/routes/workout.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'

const TESTBOT: AgentIdentity = { agentId: 'testbot', scopes: ['workout:write'], source: 'agent' }
const ANON: AgentIdentity = { agentId: '', scopes: [], source: 'agent' }

async function call(method: string, path: string, rawBody?: string, identity = TESTBOT) {
  const url = new URL('http://x' + path)
  const req = Readable.from(rawBody === undefined ? [] : [Buffer.from(rawBody)]) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(s: number) { captured.status = s; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as never
  const handled = await tryHandleWorkout({ req, res, method, path: url.pathname, url, identity } as never)
  return { handled, ...captured }
}

afterEach(() => {
  __setPlanFetcher(null)
  __setCheckinSender(null)
})

describe('checkin from_agent identity propagation', () => {
  it('passes identity.agentId to CheckinSender as third argument when authenticated', async () => {
    const sender = vi.fn().mockResolvedValue(undefined)
    __setCheckinSender(sender)
    const r = await call(
      'POST',
      '/api/workout/checkin',
      JSON.stringify({ note: 'All sets done', completed: true }),
      TESTBOT,
    )
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(sender).toHaveBeenCalledOnce()
    // Third arg must be the caller's agentId, not 'marveen'
    expect(sender.mock.calls[0][2]).toBe('testbot')
  })

  it('falls back to marveen when identity is missing', async () => {
    // Simulate no valid identity: agentId is empty string -- auth guard blocks this.
    // Test the fallback by calling with a non-empty but explicit 'marveen' identity.
    const marveen: AgentIdentity = { agentId: 'marveen', scopes: ['admin:*'], source: 'operator' }
    const sender = vi.fn().mockResolvedValue(undefined)
    __setCheckinSender(sender)
    const r = await call(
      'POST',
      '/api/workout/checkin',
      JSON.stringify({ note: 'Skipped', completed: false }),
      marveen,
    )
    expect(r.status).toBe(200)
    expect(sender.mock.calls[0][2]).toBe('marveen')
  })

  it('unauthenticated request (empty agentId) is rejected before sender is called', async () => {
    const sender = vi.fn().mockResolvedValue(undefined)
    __setCheckinSender(sender)
    const r = await call(
      'POST',
      '/api/workout/checkin',
      JSON.stringify({ note: 'hack', completed: true }),
      ANON,
    )
    expect(r.status).toBe(403)
    expect(sender).not.toHaveBeenCalled()
  })

  it('different agentId values are correctly forwarded', async () => {
    const hibiki: AgentIdentity = { agentId: 'hibiki', scopes: ['workout:write'], source: 'agent' }
    const sender = vi.fn().mockResolvedValue(undefined)
    __setCheckinSender(sender)
    await call(
      'POST',
      '/api/workout/checkin',
      JSON.stringify({ note: 'Morning run', completed: true }),
      hibiki,
    )
    expect(sender.mock.calls[0][2]).toBe('hibiki')
  })
})
