import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  enforceFromBindingEnabled,
  fromBindingStatusLine,
  decideMessageFrom,
  decideMemoryMutation,
  resolveRequestIdentity,
} from '../web/agent-identity-binding.js'
import {
  migrateAgentTokenTable,
  mintAgentToken,
  OPERATOR_AGENT_ID,
  ADMIN_SCOPE,
  type AgentIdentity,
} from '../web/agent-token-registry.js'

const SHARED = 'f'.repeat(64)
const NOW = 1_750_000_000_000

const admin: AgentIdentity = { agentId: OPERATOR_AGENT_ID, scopes: [ADMIN_SCOPE], source: 'operator' }
const dave: AgentIdentity = { agentId: 'dave', scopes: ['message:send', 'memory:delete:own'], source: 'agent' }
const applegate: AgentIdentity = { agentId: 'applegate', scopes: ['memory:delete:any'], source: 'agent' }

describe('enforceFromBindingEnabled (env-only flag, default OFF)', () => {
  it('defaults to OFF when the env var is unset or empty', () => {
    expect(enforceFromBindingEnabled({})).toBe(false)
    expect(enforceFromBindingEnabled({ ENFORCE_FROM_BINDING: '' })).toBe(false)
    expect(enforceFromBindingEnabled({ ENFORCE_FROM_BINDING: '   ' })).toBe(false)
  })

  it('enables only on an explicit truthy value (case-insensitive)', () => {
    expect(enforceFromBindingEnabled({ ENFORCE_FROM_BINDING: 'on' })).toBe(true)
    expect(enforceFromBindingEnabled({ ENFORCE_FROM_BINDING: 'ON' })).toBe(true)
    expect(enforceFromBindingEnabled({ ENFORCE_FROM_BINDING: '1' })).toBe(true)
    expect(enforceFromBindingEnabled({ ENFORCE_FROM_BINDING: 'true' })).toBe(true)
  })

  it('treats anything else as OFF (fail-safe to legacy behaviour)', () => {
    expect(enforceFromBindingEnabled({ ENFORCE_FROM_BINDING: 'off' })).toBe(false)
    expect(enforceFromBindingEnabled({ ENFORCE_FROM_BINDING: 'enabled-ish' })).toBe(false)
  })
})

describe('fromBindingStatusLine (Chad #5 mandatory startup log)', () => {
  it('renders the exact ON/OFF line the operator greps for', () => {
    expect(fromBindingStatusLine(true)).toBe('[auth] from_agent enforcement: ON')
    expect(fromBindingStatusLine(false)).toBe('[auth] from_agent enforcement: OFF')
  })
})

describe('decideMessageFrom', () => {
  it('flag OFF: passes the body `from` through unchanged (legacy, inert)', () => {
    expect(decideMessageFrom(dave, 'thor', false)).toEqual({ ok: true, from: 'thor' })
    expect(decideMessageFrom(admin, 'thor', false)).toEqual({ ok: true, from: 'thor' })
  })

  it('flag ON, agent self-send: `from` equal to the token id is allowed', () => {
    expect(decideMessageFrom(dave, 'dave', true)).toEqual({ ok: true, from: 'dave' })
  })

  it('flag ON, agent impersonation: `from` of another agent is 403', () => {
    const d = decideMessageFrom(dave, 'thor', true)
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.status).toBe(403)
  })

  it('flag ON, agent with no `from`: derives `from` from the token identity', () => {
    expect(decideMessageFrom(dave, '', true)).toEqual({ ok: true, from: 'dave' })
    expect(decideMessageFrom(dave, undefined, true)).toEqual({ ok: true, from: 'dave' })
  })

  it('flag ON, admin may still impersonate (operator relay, e.g. NoA-as-dave)', () => {
    expect(decideMessageFrom(admin, 'dave', true)).toEqual({ ok: true, from: 'dave' })
  })

  it('flag ON: normalization matches the router (a decorated id maps to the same agent)', () => {
    // sanitizeAgentIdent strips non [A-Za-z0-9_-]; "@dave" -> "dave" must NOT 403.
    expect(decideMessageFrom(dave, '@dave', true)).toEqual({ ok: true, from: 'dave' })
  })
})

describe('decideMemoryMutation (gap a -- owner-only DELETE/PUT)', () => {
  it('flag OFF: always allowed (legacy, inert until rollout)', () => {
    expect(decideMemoryMutation(dave, 'thor', false)).toEqual({ ok: true })
  })

  it('flag ON: owner may mutate their own memory', () => {
    expect(decideMemoryMutation(dave, 'dave', true)).toEqual({ ok: true })
  })

  it('flag ON: a non-owner without a curator scope is 403', () => {
    const d = decideMemoryMutation(dave, 'thor', true)
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.status).toBe(403)
  })

  it('flag ON: the curator scope (memory:delete:any) may mutate any owner', () => {
    expect(decideMemoryMutation(applegate, 'thor', true)).toEqual({ ok: true })
  })

  it('flag ON: admin may mutate any owner', () => {
    expect(decideMemoryMutation(admin, 'thor', true)).toEqual({ ok: true })
  })
})

describe('resolveRequestIdentity (gate composition: identity + expired read/write split)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    migrateAgentTokenTable(db)
  })

  it('a valid session resolves to the operator identity without a registry read', () => {
    const r = resolveRequestIdentity({ hasSession: true, bearer: undefined, db, sharedToken: SHARED, now: NOW, isWrite: true })
    expect(r.pass).toBe(true)
    if (!r.pass) return
    expect(r.identity.source).toBe('operator')
  })

  it('the shared bearer resolves to operator', () => {
    const r = resolveRequestIdentity({ hasSession: false, bearer: SHARED, db, sharedToken: SHARED, now: NOW, isWrite: true })
    expect(r.pass && r.identity.source === 'operator').toBe(true)
  })

  it('a registered per-agent token resolves to its agent identity', () => {
    const { token } = mintAgentToken(db, 'dave', ['message:send'], { now: NOW })
    const r = resolveRequestIdentity({ hasSession: false, bearer: token, db, sharedToken: SHARED, now: NOW, isWrite: true })
    expect(r.pass).toBe(true)
    if (!r.pass) return
    expect(r.identity.agentId).toBe('dave')
  })

  it('an unknown bearer (and no session) is rejected 401', () => {
    const r = resolveRequestIdentity({ hasSession: false, bearer: 'nope'.repeat(8), db, sharedToken: SHARED, now: NOW, isWrite: false })
    expect(r.pass).toBe(false)
    if (r.pass) return
    expect(r.status).toBe(401)
  })

  it('an expired per-agent token FAILS CLOSED on a write (401)', () => {
    const { token } = mintAgentToken(db, 'dave', ['message:send'], { now: NOW, ttlMs: 1000 })
    const r = resolveRequestIdentity({ hasSession: false, bearer: token, db, sharedToken: SHARED, now: NOW + 5000, isWrite: true })
    expect(r.pass).toBe(false)
    if (r.pass) return
    expect(r.status).toBe(401)
  })

  it('an expired per-agent token is PERMISSIVE on a read (GET) but carries no scopes', () => {
    const { token } = mintAgentToken(db, 'dave', ['message:send'], { now: NOW, ttlMs: 1000 })
    const r = resolveRequestIdentity({ hasSession: false, bearer: token, db, sharedToken: SHARED, now: NOW + 5000, isWrite: false })
    expect(r.pass).toBe(true)
    if (!r.pass) return
    expect(r.identity.agentId).toBe('dave')
    expect(r.identity.scopes).toEqual([]) // degraded: authenticates a read, authorizes no mutation
  })
})
