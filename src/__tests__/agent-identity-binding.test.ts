import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  enforceFromBindingEnabled,
  fromBindingStatusLine,
  logFromBindingStatus,
  decideMessageFrom,
  decideMemoryMutation,
  resolveRequestIdentity,
  detectFromMismatch,
  fromMismatchLogLine,
  logFromMismatch,
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

  it('logFromBindingStatus emits the status at boot reflecting the env flag', () => {
    const lines: string[] = []
    logFromBindingStatus((l) => lines.push(l), {})
    logFromBindingStatus((l) => lines.push(l), { ENFORCE_FROM_BINDING: 'on' })
    expect(lines).toEqual(['[auth] from_agent enforcement: OFF', '[auth] from_agent enforcement: ON'])
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

// C-INTERIM (card 38bff392): detection-only mismatch logging that ships ahead of
// per-agent token enforcement. The detector REUSES decideMessageFrom(enforce=true)
// as its predicate -- it does NOT re-implement the check -- so the C-INTERIM
// detector and the future C-BIND enforcer can never diverge, and the admin
// exclusion (incl. marveen's per-agent admin:* token, a legit impersonator) is
// inherited for free. It is flag-INDEPENDENT: it always evaluates with enforce=true
// internally and logs, while real enforcement stays gated by ENFORCE_FROM_BINDING.
describe('detectFromMismatch (C-INTERIM 38bff392, flag-independent detection)', () => {
  // A per-agent token that still carries admin:* (marveen's own token, source=agent):
  // a legit impersonator -- decideMessageFrom's admin branch must exclude it.
  const marveenAgentToken: AgentIdentity = { agentId: 'marveen', scopes: [ADMIN_SCOPE], source: 'agent' }

  it('flags a non-admin agent asserting another agent id (impersonation surface)', () => {
    expect(detectFromMismatch(dave, 'thor')).toEqual({ tokenAgent: 'dave', asserted: 'thor' })
  })

  it('does not flag a self-send (from equals the token id, decorated or not)', () => {
    expect(detectFromMismatch(dave, 'dave')).toBeNull()
    expect(detectFromMismatch(dave, '@dave')).toBeNull()
  })

  it('does not flag a derived send (empty/absent from)', () => {
    expect(detectFromMismatch(dave, '')).toBeNull()
    expect(detectFromMismatch(dave, undefined)).toBeNull()
  })

  it('does not flag the operator/admin relay (NoA-as-dave is legit, would be noise)', () => {
    expect(detectFromMismatch(admin, 'dave')).toBeNull()
  })

  it('does not flag marveen relaying with its OWN per-agent admin:* token (legit impersonator)', () => {
    // The case a hand-rolled source=agent && from!=id check would FALSE-flag;
    // reusing decideMessageFrom inherits the admin exclusion.
    expect(detectFromMismatch(marveenAgentToken, 'dave')).toBeNull()
  })

  it('flags a curator (memory:delete:any, NOT admin) asserting another agent id', () => {
    // applegate may cross-delete memories but may NOT send messages as another
    // agent -- decideMessageFrom 403s it, so detection flags it too.
    expect(detectFromMismatch(applegate, 'dave')).toEqual({ tokenAgent: 'applegate', asserted: 'dave' })
  })

  it('is flag-independent: a mismatch is detected regardless of ENFORCE_FROM_BINDING', () => {
    // The detector takes no flag; it always evaluates the enforce=true predicate.
    expect(detectFromMismatch(dave, 'thor')).not.toBeNull()
  })
})

describe('fromMismatchLogLine / logFromMismatch (C-INTERIM, gate-checkable)', () => {
  it('renders a stable, grep-able detection line', () => {
    expect(fromMismatchLogLine({ tokenAgent: 'dave', asserted: 'thor' }))
      .toBe('[auth] from_agent mismatch (detection-only): token_agent=dave asserted_from=thor')
  })

  it('emits the line on a mismatch, nothing on a clean send', () => {
    const lines: string[] = []
    const emit = (l: string) => lines.push(l)
    logFromMismatch(emit, dave, 'thor') // mismatch -> one line
    logFromMismatch(emit, dave, 'dave') // self-send -> nothing
    logFromMismatch(emit, admin, 'dave') // operator relay -> nothing
    expect(lines).toEqual(['[auth] from_agent mismatch (detection-only): token_agent=dave asserted_from=thor'])
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
