/**
 * Automation rule engine tests (DASH-031, ba1a12cb).
 *
 * Covers: evaluation core (pure), CRUD DB helpers, route handler validation.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import {
  applyRuleMigrations,
  listRules, getRule, createRule, updateRule, deleteRule,
  evaluateRules,
  type Rule, type CardSnapshot,
} from '../web/routes/rules.js'
import { tryHandleRules } from '../web/routes/rules.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

const NOW = 1_800_000_000

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
  applyRuleMigrations(getNoaDb())
})

beforeEach(() => {
  getNoaDb().prepare('DELETE FROM kanban_rules').run()
})

afterAll(() => {})

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------
function rule(over: Partial<Omit<Rule, 'id' | 'created_at' | 'updated_at'>> = {}): Omit<Rule, 'id' | 'created_at' | 'updated_at'> {
  return {
    name: 'Test rule',
    enabled: true,
    trigger_type: 'staleness',
    trigger_config: { overdue_days: 3 },
    condition_config: null,
    action_type: 'inter_agent_nudge',
    action_config: { to: 'marveen', message: 'card is stale' },
    ...over,
  }
}

function card(over: Partial<CardSnapshot> = {}): CardSnapshot {
  return {
    id: 'c1',
    status: 'planned',
    assignee: 'dave',
    priority: 'normal',
    last_moved: null,
    updated_at: NOW - 4 * 86400, // 4 days ago by default
    priority_score: 5,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
describe('Rule CRUD', () => {
  it('createRule inserts and retrieves a rule', () => {
    const r = createRule(rule(), getNoaDb())
    expect(r.id).toHaveLength(8)
    expect(r.name).toBe('Test rule')
    expect(r.enabled).toBe(true)
    expect(r.trigger_type).toBe('staleness')
    expect(r.action_type).toBe('inter_agent_nudge')
  })

  it('listRules returns all rules', () => {
    createRule(rule({ name: 'A' }), getNoaDb())
    createRule(rule({ name: 'B' }), getNoaDb())
    expect(listRules(getNoaDb())).toHaveLength(2)
  })

  it('updateRule patches a rule', () => {
    const r = createRule(rule(), getNoaDb())
    const updated = updateRule(r.id, { name: 'Updated', enabled: false }, getNoaDb())
    expect(updated?.name).toBe('Updated')
    expect(updated?.enabled).toBe(false)
  })

  it('updateRule returns null for unknown id', () => {
    expect(updateRule('nope', { name: 'X' }, getNoaDb())).toBeNull()
  })

  it('deleteRule removes the rule', () => {
    const r = createRule(rule(), getNoaDb())
    expect(deleteRule(r.id, getNoaDb())).toBe(true)
    expect(getRule(r.id, getNoaDb())).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Evaluation core
// ---------------------------------------------------------------------------
describe('evaluateRules (pure decision core)', () => {
  it('fires when card age exceeds overdue_days threshold', () => {
    const rules: Rule[] = [createRule(rule({ trigger_config: { overdue_days: 3 } }), getNoaDb())]
    const cards: CardSnapshot[] = [card({ updated_at: NOW - 4 * 86400 })] // 4 days old
    const decisions = evaluateRules(rules, cards, NOW)
    expect(decisions).toHaveLength(1)
    expect(decisions[0].actionType).toBe('inter_agent_nudge')
  })

  it('does NOT fire when card is below threshold', () => {
    const rules: Rule[] = [createRule(rule({ trigger_config: { overdue_days: 3 } }), getNoaDb())]
    const cards: CardSnapshot[] = [card({ updated_at: NOW - 2 * 86400 })] // 2 days old
    const decisions = evaluateRules(rules, cards, NOW)
    expect(decisions).toHaveLength(0)
  })

  it('skips done cards (only active statuses trigger)', () => {
    const rules: Rule[] = [createRule(rule(), getNoaDb())]
    const cards: CardSnapshot[] = [card({ status: 'done', updated_at: NOW - 10 * 86400 })]
    const decisions = evaluateRules(rules, cards, NOW)
    expect(decisions).toHaveLength(0)
  })

  it('skips disabled rules', () => {
    const rules: Rule[] = [createRule(rule({ enabled: false }), getNoaDb())]
    const cards: CardSnapshot[] = [card()]
    const decisions = evaluateRules(rules, cards, NOW)
    expect(decisions).toHaveLength(0)
  })

  it('condition_config filters by assignee', () => {
    const rules: Rule[] = [createRule(rule({ condition_config: { assignee: 'dave' } }), getNoaDb())]
    const daveCard = card({ id: 'dave-card', assignee: 'dave' })
    const otherCard = card({ id: 'other-card', assignee: 'marveen' })
    const decisions = evaluateRules(rules, [daveCard, otherCard], NOW)
    expect(decisions).toHaveLength(1)
    expect(decisions[0].cardId).toBe('dave-card')
  })

  it('condition_config filters by priority list', () => {
    const rules: Rule[] = [createRule(rule({ condition_config: { priority: ['high', 'urgent'] } }), getNoaDb())]
    const highCard = card({ id: 'hi', priority: 'high' })
    const normalCard = card({ id: 'normal', priority: 'normal' })
    const decisions = evaluateRules(rules, [highCard, normalCard], NOW)
    expect(decisions).toHaveLength(1)
    expect(decisions[0].cardId).toBe('hi')
  })

  it('uses last_moved over updated_at for age calculation', () => {
    const rules: Rule[] = [createRule(rule({ trigger_config: { overdue_days: 3 } }), getNoaDb())]
    // last_moved is recent (1 day ago) even though updated_at is old (10 days ago)
    const cards: CardSnapshot[] = [card({ last_moved: NOW - 86400, updated_at: NOW - 10 * 86400 })]
    const decisions = evaluateRules(rules, cards, NOW)
    expect(decisions).toHaveLength(0) // last_moved is 1 day < 3 days threshold
  })
})

// ---------------------------------------------------------------------------
// Route handler (validation)
// ---------------------------------------------------------------------------
async function callRoute(method: string, path: string, body?: unknown) {
  const url = new URL('http://x' + path)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(s: number) { captured.status = s; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as any
  await tryHandleRules({ req, res, method, path, url } as any)
  return captured
}

describe('POST /api/rules validation', () => {
  it('rejects missing required fields', async () => {
    const r = await callRoute('POST', '/api/rules', { name: 'X' }) // missing trigger_type + action_type
    expect(r.status).toBe(400)
  })

  it('creates a rule and returns 200', async () => {
    const r = await callRoute('POST', '/api/rules', {
      name: 'My rule', trigger_type: 'staleness', action_type: 'inter_agent_nudge',
    })
    expect(r.status).toBe(200)
    expect(r.body.id).toHaveLength(8)
  })

  it('GET /api/rules returns list', async () => {
    await callRoute('POST', '/api/rules', {
      name: 'R1', trigger_type: 'staleness', action_type: 'inter_agent_nudge',
    })
    const r = await callRoute('GET', '/api/rules')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })

  it('rejects unknown trigger_type', async () => {
    const r = await callRoute('POST', '/api/rules', {
      name: 'X', trigger_type: 'invalid_trigger', action_type: 'inter_agent_nudge',
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/trigger_type/)
  })

  it('rejects unknown action_type', async () => {
    const r = await callRoute('POST', '/api/rules', {
      name: 'X', trigger_type: 'staleness', action_type: 'drop_table',
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/action_type/)
  })
})

describe('PUT /api/rules/:id validation', () => {
  it('rejects unknown trigger_type in update', async () => {
    const created = await callRoute('POST', '/api/rules', {
      name: 'R', trigger_type: 'staleness', action_type: 'inter_agent_nudge',
    })
    const r = await callRoute('PUT', `/api/rules/${created.body.id}`, { trigger_type: 'bad_type' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/trigger_type/)
  })

  it('rejects unknown action_type in update', async () => {
    const created = await callRoute('POST', '/api/rules', {
      name: 'R', trigger_type: 'staleness', action_type: 'inter_agent_nudge',
    })
    const r = await callRoute('PUT', `/api/rules/${created.body.id}`, { action_type: 'xss_inject' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/action_type/)
  })
})
