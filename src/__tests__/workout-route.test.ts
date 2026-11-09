// Tests for GET /api/workout/plan + POST /api/workout/checkin (card f22c8803, Phase 0D)
// TDD: network-free, memory seams.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import {
  tryHandleWorkout,
  __setPlanFetcher,
  __setCheckinSender,
} from '../web/routes/workout.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'
import type { WorkoutPlan } from '../types/app.js'

const AUTH: AgentIdentity = { agentId: 'marveen', scopes: ['admin:*'], source: 'operator' }
const ANON: AgentIdentity = { agentId: '', scopes: [], source: 'agent' }

async function call(method: string, path: string, rawBody?: string, identity = AUTH) {
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

describe('route guard', () => {
  it('passes through unrelated paths', async () => {
    expect((await call('GET', '/api/kanban')).handled).toBe(false)
  })
})

describe('GET /api/workout/plan', () => {
  it('requires authentication', async () => {
    __setPlanFetcher(vi.fn().mockResolvedValue(null))
    const r = await call('GET', '/api/workout/plan', undefined, ANON)
    expect(r.status).toBe(403)
  })

  it('returns plan from fetcher', async () => {
    const plan: WorkoutPlan = { date: '2026-11-09', exercises: [{ name: 'Squat', sets: 4, reps: 8, weight: 80, unit: 'kg' }], notes: null }
    __setPlanFetcher(vi.fn().mockResolvedValue(plan))
    const r = await call('GET', '/api/workout/plan')
    expect(r.status).toBe(200)
    expect(r.body.plan.date).toBe('2026-11-09')
    expect(r.body.plan.exercises[0].name).toBe('Squat')
  })

  it('returns null plan when Hibiki has no data', async () => {
    __setPlanFetcher(vi.fn().mockResolvedValue(null))
    const r = await call('GET', '/api/workout/plan')
    expect(r.status).toBe(200)
    expect(r.body.plan).toBeNull()
  })
})

describe('POST /api/workout/checkin', () => {
  it('requires authentication', async () => {
    __setCheckinSender(vi.fn().mockResolvedValue(undefined))
    const r = await call('POST', '/api/workout/checkin', '{}', ANON)
    expect(r.status).toBe(403)
  })

  it('rejects invalid JSON with 400', async () => {
    __setCheckinSender(vi.fn().mockResolvedValue(undefined))
    const r = await call('POST', '/api/workout/checkin', '{bad')
    expect(r.status).toBe(400)
  })

  it('rejects missing exercise_id or note with 400', async () => {
    __setCheckinSender(vi.fn().mockResolvedValue(undefined))
    const r = await call('POST', '/api/workout/checkin', '{}')
    expect(r.status).toBe(400)
  })

  it('calls checkin sender and returns 200', async () => {
    const sender = vi.fn().mockResolvedValue(undefined)
    __setCheckinSender(sender)
    const r = await call('POST', '/api/workout/checkin', JSON.stringify({ note: 'Great session', completed: true }))
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(sender).toHaveBeenCalledOnce()
  })
})
