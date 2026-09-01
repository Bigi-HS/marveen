/**
 * Automation rule engine (DASH-031, ba1a12cb).
 *
 * Rules: trigger -> condition -> action
 * Triggers: 'staleness' (card overdue) | 'status_change' (card moved) | 'manual'
 * Actions: 'inter_agent_nudge' | 'telegram_escalate' | 'reassign'
 *
 * Storage: kanban_rules table in noa.db.
 * Evaluation: pure decision core in evaluateRules() -- IO-free, unit-testable.
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getNoaDb } from '../../noa-db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const RULE_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS kanban_rules (
     id            TEXT    PRIMARY KEY,
     name          TEXT    NOT NULL,
     enabled       INTEGER NOT NULL DEFAULT 1,
     trigger_type  TEXT    NOT NULL,
     trigger_config TEXT,
     condition_config TEXT,
     action_type   TEXT    NOT NULL,
     action_config TEXT,
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rules_trigger ON kanban_rules (trigger_type, enabled)`,
]

export function applyRuleMigrations(db: Database.Database = getNoaDb()): void {
  for (const stmt of RULE_MIGRATIONS) {
    try { db.exec(stmt) } catch { /* already exists */ }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type TriggerType = 'staleness' | 'status_change' | 'manual'
export type ActionType = 'inter_agent_nudge' | 'telegram_escalate' | 'reassign'

const VALID_TRIGGER_TYPES: readonly string[] = ['staleness', 'status_change', 'manual']
const VALID_ACTION_TYPES: readonly string[] = ['inter_agent_nudge', 'telegram_escalate', 'reassign']

export interface Rule {
  id: string
  name: string
  enabled: boolean
  trigger_type: TriggerType
  trigger_config: Record<string, unknown> | null
  condition_config: Record<string, unknown> | null
  action_type: ActionType
  action_config: Record<string, unknown> | null
  created_at: number
  updated_at: number
}

type RuleRow = Omit<Rule, 'enabled' | 'trigger_config' | 'condition_config' | 'action_config'> & {
  enabled: number
  trigger_config: string | null
  condition_config: string | null
  action_config: string | null
}

function parseRule(row: RuleRow): Rule {
  return {
    ...row,
    enabled: row.enabled === 1,
    trigger_config: row.trigger_config ? JSON.parse(row.trigger_config) : null,
    condition_config: row.condition_config ? JSON.parse(row.condition_config) : null,
    action_config: row.action_config ? JSON.parse(row.action_config) : null,
  }
}

// ---------------------------------------------------------------------------
// Pure evaluation core
// ---------------------------------------------------------------------------
export interface CardSnapshot {
  id: string
  status: string
  assignee: string | null
  priority: string
  last_moved: number | null
  updated_at: number
  priority_score: number | null
}

export interface EvalDecision {
  ruleId: string
  ruleName: string
  cardId: string
  actionType: ActionType
  actionConfig: Record<string, unknown> | null
  reason: string
}

const STALE_SECONDS_BY_SCORE: Record<number, number> = {
  1: 2 * 3600, 2: 12 * 3600,
  3: 24 * 3600, 4: 24 * 3600,
  5: 3 * 86400, 6: 3 * 86400, 7: 3 * 86400,
  8: 7 * 86400, 9: 7 * 86400, 10: 7 * 86400,
}
const ACTIVE_STATUSES = new Set(['planned', 'in_progress', 'waiting'])

function cardAgeSeconds(card: CardSnapshot, nowSec: number): number | null {
  const ts = card.last_moved ?? card.updated_at
  return nowSec - ts
}

function matchesCondition(card: CardSnapshot, condition: Record<string, unknown> | null): boolean {
  if (!condition) return true
  if (condition.assignee != null && card.assignee !== condition.assignee) return false
  if (condition.status != null && card.status !== condition.status) return false
  if (Array.isArray(condition.priority) && !(condition.priority as string[]).includes(card.priority)) return false
  return true
}

/**
 * Pure evaluation of staleness-trigger rules against a set of card snapshots.
 * Returns one EvalDecision per (rule, card) pair that should trigger an action.
 * No I/O -- the caller is responsible for fetching cards and executing actions.
 */
export function evaluateRules(
  rules: Rule[],
  cards: CardSnapshot[],
  nowSec: number,
): EvalDecision[] {
  const decisions: EvalDecision[] = []

  for (const rule of rules) {
    if (!rule.enabled) continue
    if (rule.trigger_type !== 'staleness') continue

    const overdueDays = (rule.trigger_config?.overdue_days as number | undefined) ?? 3
    const overdueSeconds = overdueDays * 86400

    for (const card of cards) {
      if (!ACTIVE_STATUSES.has(card.status)) continue

      const age = cardAgeSeconds(card, nowSec)
      if (age === null || age < overdueSeconds) continue

      if (!matchesCondition(card, rule.condition_config)) continue

      decisions.push({
        ruleId: rule.id,
        ruleName: rule.name,
        cardId: card.id,
        actionType: rule.action_type,
        actionConfig: rule.action_config,
        reason: `staleness trigger: card age ${Math.round(age / 3600)}h >= ${overdueDays}d threshold`,
      })
    }
  }

  return decisions
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
export function listRules(db: Database.Database = getNoaDb()): Rule[] {
  applyRuleMigrations(db)
  const rows = db.prepare('SELECT * FROM kanban_rules ORDER BY created_at ASC').all() as RuleRow[]
  return rows.map(parseRule)
}

export function getRule(id: string, db: Database.Database = getNoaDb()): Rule | null {
  applyRuleMigrations(db)
  const row = db.prepare('SELECT * FROM kanban_rules WHERE id = ?').get(id) as RuleRow | undefined
  return row ? parseRule(row) : null
}

export function createRule(
  input: Omit<Rule, 'id' | 'created_at' | 'updated_at'>,
  db: Database.Database = getNoaDb(),
): Rule {
  applyRuleMigrations(db)
  const now = Math.floor(Date.now() / 1000)
  const id = randomUUID().slice(0, 8)
  db.prepare(
    `INSERT INTO kanban_rules (id, name, enabled, trigger_type, trigger_config, condition_config, action_type, action_config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.name, input.enabled ? 1 : 0, input.trigger_type,
    input.trigger_config ? JSON.stringify(input.trigger_config) : null,
    input.condition_config ? JSON.stringify(input.condition_config) : null,
    input.action_type,
    input.action_config ? JSON.stringify(input.action_config) : null,
    now, now,
  )
  return getRule(id, db)!
}

export function updateRule(
  id: string,
  patch: Partial<Omit<Rule, 'id' | 'created_at' | 'updated_at'>>,
  db: Database.Database = getNoaDb(),
): Rule | null {
  const cur = getRule(id, db)
  if (!cur) return null
  const now = Math.floor(Date.now() / 1000)
  const merged = { ...cur, ...patch, updated_at: now }
  db.prepare(
    `UPDATE kanban_rules SET name=?, enabled=?, trigger_type=?, trigger_config=?, condition_config=?, action_type=?, action_config=?, updated_at=? WHERE id=?`
  ).run(
    merged.name, merged.enabled ? 1 : 0, merged.trigger_type,
    merged.trigger_config ? JSON.stringify(merged.trigger_config) : null,
    merged.condition_config ? JSON.stringify(merged.condition_config) : null,
    merged.action_type,
    merged.action_config ? JSON.stringify(merged.action_config) : null,
    now, id,
  )
  return getRule(id, db)
}

export function deleteRule(id: string, db: Database.Database = getNoaDb()): boolean {
  applyRuleMigrations(db)
  return db.prepare('DELETE FROM kanban_rules WHERE id = ?').run(id).changes > 0
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function tryHandleRules(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/rules' && method === 'GET') {
    json(res, listRules())
    return true
  }

  if (path === '/api/rules' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString()) as Partial<Rule>
    if (!body.name?.trim() || !body.trigger_type || !body.action_type) {
      json(res, { error: 'name, trigger_type, action_type required' }, 400)
      return true
    }
    if (!VALID_TRIGGER_TYPES.includes(body.trigger_type)) {
      json(res, { error: `invalid trigger_type; valid: ${VALID_TRIGGER_TYPES.join(', ')}` }, 400)
      return true
    }
    if (!VALID_ACTION_TYPES.includes(body.action_type)) {
      json(res, { error: `invalid action_type; valid: ${VALID_ACTION_TYPES.join(', ')}` }, 400)
      return true
    }
    const rule = createRule({
      name: body.name.trim(),
      enabled: body.enabled !== false,
      trigger_type: body.trigger_type as TriggerType,
      trigger_config: (body.trigger_config as Record<string, unknown>) ?? null,
      condition_config: (body.condition_config as Record<string, unknown>) ?? null,
      action_type: body.action_type as ActionType,
      action_config: (body.action_config as Record<string, unknown>) ?? null,
    })
    json(res, rule)
    return true
  }

  const idMatch = path.match(/^\/api\/rules\/([^/]+)$/)
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1])
    if (method === 'GET') {
      const rule = getRule(id)
      if (!rule) { json(res, { error: 'Not found' }, 404); return true }
      json(res, rule)
      return true
    }
    if (method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString()) as Partial<Rule>
      if (body.trigger_type !== undefined && !VALID_TRIGGER_TYPES.includes(body.trigger_type)) {
        json(res, { error: `invalid trigger_type; valid: ${VALID_TRIGGER_TYPES.join(', ')}` }, 400)
        return true
      }
      if (body.action_type !== undefined && !VALID_ACTION_TYPES.includes(body.action_type)) {
        json(res, { error: `invalid action_type; valid: ${VALID_ACTION_TYPES.join(', ')}` }, 400)
        return true
      }
      const updated = updateRule(id, body)
      if (!updated) { json(res, { error: 'Not found' }, 404); return true }
      json(res, updated)
      return true
    }
    if (method === 'DELETE') {
      if (!deleteRule(id)) { json(res, { error: 'Not found' }, 404); return true }
      json(res, { ok: true })
      return true
    }
  }

  return false
}
