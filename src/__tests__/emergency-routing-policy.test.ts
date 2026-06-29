// Per-agent emergency-routing policy gate (card d1ccf1d9, token-outage Layer-2).
//
// This gate sits ON THE NODE SIDE, BEFORE the python fallback-LLM client is ever
// invoked. It is a SECOND, independent layer over the client's own sensitivity
// routing: it can only ever be STRICTER (deny what the client would allow),
// never looser. The HARD rule under test is PII-local: a flagged agent NEVER
// egresses to any external LLM, regardless of task config.

import { describe, it, expect } from 'vitest'
import {
  evaluateEmergencyRouting,
  getAgentPolicy,
  normalizeSensitivity,
  isLayer2TaskType,
  EMERGENCY_ROUTING_POLICY,
  DEFAULT_POLICY,
} from '../web/emergency-routing-policy.js'

describe('PII-local hard rule (never egress)', () => {
  it('hibiki is PII-local and is blocked for every task-type/sensitivity', () => {
    const policy = getAgentPolicy('hibiki')
    expect(policy.piiLocal).toBe(true)
    for (const tt of ['coaching_reply', 'reminder_parse', 'kanban_card_from_text']) {
      for (const s of ['low', 'medium', 'high', undefined]) {
        const d = evaluateEmergencyRouting('hibiki', tt, s)
        expect(d.allowed).toBe(false)
        expect(d.reason).toBe('pii_local_blocked')
      }
    }
  })

  it('claudia is PII-local and is blocked for every task-type/sensitivity', () => {
    expect(getAgentPolicy('claudia').piiLocal).toBe(true)
    const d = evaluateEmergencyRouting('claudia', 'reminder_parse', 'low')
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('pii_local_blocked')
  })

  it('PII-local takes precedence over an otherwise-allowed task-type', () => {
    // Even if a PII-local agent had a task-type that would normally pass, the
    // PII-local block fires first.
    const d = evaluateEmergencyRouting('hibiki', 'coaching_reply', 'low')
    expect(d).toEqual({ allowed: false, reason: 'pii_local_blocked' })
  })
})

describe('per-agent task-type allowlist', () => {
  it('bond may route coaching_reply at low sensitivity', () => {
    expect(evaluateEmergencyRouting('bond', 'coaching_reply', 'low')).toEqual({
      allowed: true,
      reason: 'ok',
    })
  })

  it('bond may NOT route kanban_card_from_text (not in its allowlist)', () => {
    const d = evaluateEmergencyRouting('bond', 'kanban_card_from_text', 'low')
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('task_type_not_allowed_for_agent')
  })

  it('marveen may route reminder_parse and kanban_card_from_text at low', () => {
    expect(evaluateEmergencyRouting('marveen', 'reminder_parse', 'low').allowed).toBe(true)
    expect(evaluateEmergencyRouting('marveen', 'kanban_card_from_text', 'low').allowed).toBe(true)
  })

  it('marveen may NOT route coaching_reply (not in its allowlist)', () => {
    expect(evaluateEmergencyRouting('marveen', 'coaching_reply', 'low').reason).toBe(
      'task_type_not_allowed_for_agent',
    )
  })
})

describe('sensitivity ceiling (blocks raw sensitive content egress)', () => {
  it('marveen low ceiling blocks a high-sensitivity (raw Boss-DM) task', () => {
    const d = evaluateEmergencyRouting('marveen', 'reminder_parse', 'high')
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('sensitivity_exceeds_ceiling')
  })

  it('a medium-sensitivity task also exceeds the conservative low ceiling', () => {
    expect(evaluateEmergencyRouting('marveen', 'reminder_parse', 'medium').reason).toBe(
      'sensitivity_exceeds_ceiling',
    )
  })

  it('absent sensitivity fails safe to high -> blocked by low ceiling', () => {
    const d = evaluateEmergencyRouting('marveen', 'reminder_parse', undefined)
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('sensitivity_exceeds_ceiling')
  })

  it('invalid sensitivity string also fails safe to high -> blocked', () => {
    expect(evaluateEmergencyRouting('bond', 'coaching_reply', 'banana').reason).toBe(
      'sensitivity_exceeds_ceiling',
    )
  })
})

describe('unlisted agent deny-by-default', () => {
  it('an unknown agent gets the deny-by-default policy', () => {
    expect(getAgentPolicy('nonexistent-agent')).toBe(DEFAULT_POLICY)
  })

  it('an unlisted agent cannot route any task (empty allowlist)', () => {
    const d = evaluateEmergencyRouting('radar', 'reminder_parse', 'low')
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('task_type_not_allowed_for_agent')
  })

  it('the default policy is not PII-local but has an empty allowlist + low ceiling', () => {
    expect(DEFAULT_POLICY.piiLocal).toBe(false)
    expect(DEFAULT_POLICY.allowedTaskTypes).toHaveLength(0)
    expect(DEFAULT_POLICY.maxEgressSensitivity).toBe('low')
  })
})

describe('unknown task-type rejection', () => {
  it('an unrecognised task-type is rejected before the allowlist check', () => {
    const d = evaluateEmergencyRouting('bond', 'exfiltrate_everything', 'low')
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('unknown_task_type')
  })

  it('isLayer2TaskType recognises exactly the three known types', () => {
    expect(isLayer2TaskType('coaching_reply')).toBe(true)
    expect(isLayer2TaskType('reminder_parse')).toBe(true)
    expect(isLayer2TaskType('kanban_card_from_text')).toBe(true)
    expect(isLayer2TaskType('anything_else')).toBe(false)
    expect(isLayer2TaskType('')).toBe(false)
  })
})

describe('normalizeSensitivity (fail-safe to high)', () => {
  it('passes through valid levels', () => {
    expect(normalizeSensitivity('low')).toBe('low')
    expect(normalizeSensitivity('medium')).toBe('medium')
    expect(normalizeSensitivity('high')).toBe('high')
  })

  it('absent/null/invalid -> high (matches the python client T2 default)', () => {
    expect(normalizeSensitivity(undefined)).toBe('high')
    expect(normalizeSensitivity(null)).toBe('high')
    expect(normalizeSensitivity('LOW')).toBe('high') // case-sensitive, fail safe
    expect(normalizeSensitivity('')).toBe('high')
  })
})

describe('registry audit invariants', () => {
  it('every PII-local agent has an empty allowlist (defence-in-depth)', () => {
    for (const [agent, policy] of Object.entries(EMERGENCY_ROUTING_POLICY)) {
      if (policy.piiLocal) {
        expect(policy.allowedTaskTypes, `${agent} pii-local must not allow any task-type`).toHaveLength(0)
      }
    }
  })

  it('every listed agent carries a non-empty rationale (auditability)', () => {
    for (const [agent, policy] of Object.entries(EMERGENCY_ROUTING_POLICY)) {
      expect(policy.rationale.trim().length, `${agent} needs an audit rationale`).toBeGreaterThan(0)
    }
  })

  it('hibiki and claudia are the declared PII-local agents', () => {
    const piiLocal = Object.entries(EMERGENCY_ROUTING_POLICY)
      .filter(([, p]) => p.piiLocal)
      .map(([a]) => a)
      .sort()
    expect(piiLocal).toEqual(['claudia', 'hibiki'])
  })
})
