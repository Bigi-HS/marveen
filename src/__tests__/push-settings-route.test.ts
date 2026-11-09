// TDD: tests for GET/PUT /api/push/settings (Phase 2C, card 2f8257b2)
// Network-free: uses injected in-memory settings DB seam.

import { describe, it, expect, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import {
  tryHandlePush,
  __setSettingsDbSeam,
  type PushSettings,
  PUSH_CATEGORIES,
} from '../web/routes/push.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'

const OPERATOR: AgentIdentity = { agentId: 'marveen', scopes: ['admin:*'], source: 'operator' }
const AGENT: AgentIdentity = { agentId: 'dave', scopes: [], source: 'agent' }
const ANON: AgentIdentity = { agentId: '', scopes: [], source: 'agent' }

async function call(
  method: string,
  path: string,
  rawBody?: string,
  identity: AgentIdentity = ANON,
) {
  const url = new URL('http://x' + path)
  const req = Object.assign(
    Readable.from(rawBody === undefined ? [] : [Buffer.from(rawBody)]),
    { socket: { remoteAddress: '127.0.0.1' } },
  ) as never
  const captured: { status: number; body: unknown } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as never
  const handled = await tryHandlePush({ req, res, method, path: url.pathname, url, identity } as never)
  return { handled, ...captured }
}

function makeMemSettingsDb() {
  const store = new Map<string, boolean>()
  return {
    getSettings(): PushSettings {
      const defaults: PushSettings = { workout: true, todo: true, fleet: true, journal: true }
      for (const cat of PUSH_CATEGORIES) {
        if (store.has(cat)) defaults[cat] = store.get(cat)!
      }
      return defaults
    },
    setCategory(category: string, enabled: boolean): void {
      store.set(category, enabled)
    },
    _store: store,
  }
}

afterEach(() => {
  __setSettingsDbSeam(null)
})

describe('GET /api/push/settings', () => {
  it('returns default settings (all enabled) with no stored data', async () => {
    __setSettingsDbSeam(makeMemSettingsDb())
    const r = await call('GET', '/api/push/settings', undefined, AGENT)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ workout: true, todo: true, fleet: true, journal: true })
  })

  it('returns stored settings', async () => {
    const db = makeMemSettingsDb()
    db.setCategory('workout', false)
    __setSettingsDbSeam(db)
    const r = await call('GET', '/api/push/settings', undefined, AGENT)
    expect(r.status).toBe(200)
    expect((r.body as PushSettings).workout).toBe(false)
    expect((r.body as PushSettings).todo).toBe(true)
  })

  it('requires authenticated identity', async () => {
    __setSettingsDbSeam(makeMemSettingsDb())
    const r = await call('GET', '/api/push/settings', undefined, ANON)
    expect(r.status).toBe(403)
  })

  it('operator identity can read settings', async () => {
    __setSettingsDbSeam(makeMemSettingsDb())
    const r = await call('GET', '/api/push/settings', undefined, OPERATOR)
    expect(r.status).toBe(200)
  })
})

describe('PUT /api/push/settings', () => {
  it('updates a single category', async () => {
    const db = makeMemSettingsDb()
    __setSettingsDbSeam(db)
    const r = await call('PUT', '/api/push/settings', JSON.stringify({ workout: false }), AGENT)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect((r.body as PushSettings).workout).toBe(false)
    expect((r.body as PushSettings).todo).toBe(true)
    expect(db._store.get('workout')).toBe(false)
  })

  it('updates multiple categories at once', async () => {
    const db = makeMemSettingsDb()
    __setSettingsDbSeam(db)
    const r = await call('PUT', '/api/push/settings', JSON.stringify({ todo: false, fleet: false }), AGENT)
    expect(r.status).toBe(200)
    expect((r.body as PushSettings).todo).toBe(false)
    expect((r.body as PushSettings).fleet).toBe(false)
    expect((r.body as PushSettings).workout).toBe(true)
  })

  it('ignores unknown categories silently', async () => {
    const db = makeMemSettingsDb()
    __setSettingsDbSeam(db)
    const r = await call('PUT', '/api/push/settings', JSON.stringify({ unknown_key: false, workout: false }), AGENT)
    expect(r.status).toBe(200)
    expect((r.body as PushSettings).workout).toBe(false)
    expect(db._store.has('unknown_key')).toBe(false)
  })

  it('requires authenticated identity', async () => {
    __setSettingsDbSeam(makeMemSettingsDb())
    const r = await call('PUT', '/api/push/settings', '{}', ANON)
    expect(r.status).toBe(403)
  })

  it('returns 400 on invalid JSON body', async () => {
    __setSettingsDbSeam(makeMemSettingsDb())
    const r = await call('PUT', '/api/push/settings', 'not-json', AGENT)
    expect(r.status).toBe(400)
  })

  it('returns 413 when body exceeds 4096 bytes (maxBytes guard)', async () => {
    __setSettingsDbSeam(makeMemSettingsDb())
    // 4097-byte body: should be rejected before JSON parse
    const oversized = JSON.stringify({ workout: false, padding: 'x'.repeat(4100) })
    const r = await call('PUT', '/api/push/settings', oversized, AGENT)
    expect(r.status).toBe(413)
  })
})
