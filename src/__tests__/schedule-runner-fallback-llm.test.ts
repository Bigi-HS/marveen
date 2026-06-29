// Schedule-runner routing-decision tests for the token-outage Layer-2 fallback
// LLM bypass (card 92f07145, spec store/spec-layer2-fallback-llm.md AC-1).
//
// As with the Layer-1 direct-send tests, the runner is tmux/DB-coupled, so we
// cover the pure routing predicate (shouldFallbackLLM) here. AC-1c is the key
// invariant: Layer 2 only fires when Layer 1 did NOT (directSend !== true), so
// a task never falls through both paths.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  shouldFallbackLLM,
  shouldDirectSend,
  readLayer2TaskConfig,
  fallbackEgressDecision,
} from '../web/schedule-runner.js'

const limited = { limited: true }
const healthy = { limited: false }

describe('shouldFallbackLLM (AC-1 Layer-2 trigger)', () => {
  it('limited + layer2=true + directSend absent -> fires Layer 2', () => {
    expect(shouldFallbackLLM({ layer2: true }, limited)).toBe(true)
  })

  it('limited + layer2=true + directSend=false -> fires Layer 2', () => {
    expect(shouldFallbackLLM({ layer2: true, directSend: false }, limited)).toBe(true)
  })

  it('AC-1c: limited + layer2=true + directSend=true -> Layer 1 owns it, NOT Layer 2', () => {
    expect(shouldFallbackLLM({ layer2: true, directSend: true }, limited)).toBe(false)
  })

  it('NOT limited + layer2=true -> normal path', () => {
    expect(shouldFallbackLLM({ layer2: true }, healthy)).toBe(false)
  })

  it('limited + layer2 absent -> normal path', () => {
    expect(shouldFallbackLLM({}, limited)).toBe(false)
  })

  it('limited + layer2=false -> normal path', () => {
    expect(shouldFallbackLLM({ layer2: false }, limited)).toBe(false)
  })

  it('null/absent state -> normal path', () => {
    expect(shouldFallbackLLM({ layer2: true }, null)).toBe(false)
  })
})

describe('Layer-1 / Layer-2 mutual exclusivity (no double-fire, no fall-through)', () => {
  // For every task shape under a limited state, at most one layer claims it.
  const shapes = [
    { directSend: true, layer2: true },
    { directSend: true, layer2: false },
    { directSend: false, layer2: true },
    { directSend: false, layer2: false },
    { layer2: true },
    {},
  ]
  it('directSend and layer2 are never both true for the same tick', () => {
    for (const s of shapes) {
      const l1 = shouldDirectSend(s, limited)
      const l2 = shouldFallbackLLM(s, limited)
      expect(l1 && l2).toBe(false)
    }
  })

  it('a directSend task always routes to Layer 1, never Layer 2', () => {
    expect(shouldDirectSend({ directSend: true }, limited)).toBe(true)
    expect(shouldFallbackLLM({ directSend: true, layer2: true }, limited)).toBe(false)
  })
})

// readLayer2TaskConfig feeds the per-agent emergency-routing policy gate (card
// d1ccf1d9): it extracts the layer2_task_type + sensitivity that the python
// client reads, so the node gate can decide on egress BEFORE invoking the client.
describe('readLayer2TaskConfig (card d1ccf1d9 policy-gate input)', () => {
  let baseDir: string

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'l2-cfg-'))
    const write = (name: string, cfg: unknown) => {
      const dir = join(baseDir, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'task-config.json'), JSON.stringify(cfg))
    }
    write('full', { layer2: true, layer2_task_type: 'coaching_reply', sensitivity: 'low' })
    write('no-fields', { layer2: true })
    write('non-string', { layer2_task_type: 123, sensitivity: { nested: true } })
    // 'malformed' dir with broken JSON
    const md = join(baseDir, 'malformed')
    mkdirSync(md, { recursive: true })
    writeFileSync(join(md, 'task-config.json'), '{ not valid json')
  })

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('extracts task-type and sensitivity when present', () => {
    expect(readLayer2TaskConfig('full', baseDir)).toEqual({
      taskType: 'coaching_reply',
      sensitivity: 'low',
    })
  })

  it('returns undefined fields when absent (gate then fails safe)', () => {
    expect(readLayer2TaskConfig('no-fields', baseDir)).toEqual({
      taskType: undefined,
      sensitivity: undefined,
    })
  })

  it('ignores non-string field values (fail-safe to undefined)', () => {
    expect(readLayer2TaskConfig('non-string', baseDir)).toEqual({
      taskType: undefined,
      sensitivity: undefined,
    })
  })

  it('tolerates a malformed config file -> empty object', () => {
    expect(readLayer2TaskConfig('malformed', baseDir)).toEqual({})
  })

  it('tolerates a missing task dir -> empty object', () => {
    expect(readLayer2TaskConfig('does-not-exist', baseDir)).toEqual({})
  })
})

// fallbackEgressDecision is the SINGLE egress chokepoint inside runFallbackLLM
// (card d1ccf1d9). It must be unbypassable (lives in the egress function) and
// FAIL-CLOSED (a throwing policy layer blocks egress, never silent-passes).
describe('fallbackEgressDecision (egress chokepoint + fail-closed)', () => {
  const okReader = (taskType: string, sensitivity: string) => () => ({ taskType, sensitivity })

  it('allows an in-policy agent/task/sensitivity', () => {
    const d = fallbackEgressDecision('bond', 'any', okReader('coaching_reply', 'low'))
    expect(d).toEqual({ allowed: true, reason: 'ok' })
  })

  it('blocks a PII-local agent regardless of task config', () => {
    const d = fallbackEgressDecision('hibiki', 'any', okReader('coaching_reply', 'low'))
    expect(d).toEqual({ allowed: false, reason: 'pii_local_blocked' })
  })

  it('blocks a high-sensitivity task against the conservative ceiling', () => {
    const d = fallbackEgressDecision('marveen', 'any', okReader('reminder_parse', 'high'))
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('sensitivity_exceeds_ceiling')
  })

  it('FAIL-CLOSED: a throwing config reader blocks egress', () => {
    const throwingReader = () => {
      throw new Error('simulated DB/import failure')
    }
    const d = fallbackEgressDecision('bond', 'any', throwingReader)
    expect(d).toEqual({ allowed: false, reason: 'policy_error_failclosed' })
  })

  it('FAIL-CLOSED never silent-passes (allowed stays false on error)', () => {
    const d = fallbackEgressDecision('marveen', 'any', () => {
      throw new Error('boom')
    })
    expect(d.allowed).toBe(false)
  })
})
