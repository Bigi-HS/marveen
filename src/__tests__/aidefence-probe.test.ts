// AIDefence pipeline health probe tests (card ef918983).
// Verifies runAiDefenceProbe() correctly detects pipeline health:
//   - verdict from aiDefenceGuard matches expected
//   - row appears in guard_events after recordGuardEvent()
//   - probe reports ok=false when either check fails

import { describe, it, expect, vi } from 'vitest'
import { runAiDefenceProbe, type AiDefenceProbeDeps } from '../web/aidefence-probe.js'
import { aiDefenceGuard } from '../aidefence-guard.js'
import type { GuardEventRow } from '../db.js'
import {
  PROBE_CONTENT,
  PROBE_EXPECTED_VERDICT,
  BLOCK_CONTENT,
  PASS_CONTENT,
} from './fixtures/aidefence-injection-samples.js'

const NOW_SEC = 1_700_000_000

function makeRow(overrides: Partial<GuardEventRow> = {}): GuardEventRow {
  return {
    id: 1, created_at: NOW_SEC, mechanism: 'messages-guard', route: '/api/messages',
    verdict: 'FLAG', from_agent: 'aidefence-probe', to_agent: null,
    pattern_ids: 'email', max_severity: 'medium', finding_count: 1,
    content_hash: 'abc', content_len: 50, ...overrides,
  }
}

function makeDeps(overrides: Partial<AiDefenceProbeDeps> = {}): AiDefenceProbeDeps {
  let rows: GuardEventRow[] = []
  return {
    guard: aiDefenceGuard,
    record: vi.fn((_input, _nowSec) => { rows.push(makeRow()) }),
    getEvents: vi.fn((_limit?: number, _since?: number) => [...rows]),
    nowSec: () => NOW_SEC,
    ...overrides,
  }
}

// ---- fixture content verification ----------------------------------------

describe('fixture content -- aiDefenceGuard verdicts', () => {
  it('PROBE_CONTENT triggers FLAG (email PII medium)', () => {
    const r = aiDefenceGuard('test', PROBE_CONTENT)
    expect(r.verdict).toBe(PROBE_EXPECTED_VERDICT)
    expect(r.findings.some(f => f.pattern === 'email')).toBe(true)
  })

  it('BLOCK_CONTENT triggers BLOCK (injection critical)', () => {
    const r = aiDefenceGuard('test', BLOCK_CONTENT)
    expect(r.verdict).toBe('BLOCK')
  })

  it('PASS_CONTENT triggers PASS', () => {
    const r = aiDefenceGuard('test', PASS_CONTENT)
    expect(r.verdict).toBe('PASS')
  })
})

// ---- happy path -----------------------------------------------------------

describe('runAiDefenceProbe -- happy path', () => {
  it('ok=true when verdict matches and row is recorded', () => {
    const deps = makeDeps()
    const result = runAiDefenceProbe(deps)
    expect(result.ok).toBe(true)
    expect(result.verdictMatch).toBe(true)
    expect(result.recorded).toBe(true)
    expect(result.verdict).toBe('FLAG')
  })

  it('calls guard with the probe content and records the result', () => {
    const guardSpy = vi.fn(aiDefenceGuard)
    const deps = makeDeps({ guard: guardSpy })
    runAiDefenceProbe(deps)
    expect(guardSpy).toHaveBeenCalledOnce()
    expect(deps.record).toHaveBeenCalledOnce()
  })

  it('passes nowSec to recordGuardEvent for a stable timestamp', () => {
    const deps = makeDeps()
    runAiDefenceProbe(deps)
    const recordCall = vi.mocked(deps.record).mock.calls[0]
    expect(recordCall[1]).toBe(NOW_SEC)
  })
})

// ---- verdict mismatch ----------------------------------------------------

describe('runAiDefenceProbe -- verdict mismatch', () => {
  it('verdictMatch=false and ok=false when guard returns unexpected verdict', () => {
    const deps = makeDeps({
      guard: vi.fn(() => ({ verdict: 'PASS' as const, findings: [] })),
    })
    const result = runAiDefenceProbe(deps)
    expect(result.verdictMatch).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.verdict).toBe('PASS')
  })
})

// ---- recording failure ---------------------------------------------------

describe('runAiDefenceProbe -- recording failure', () => {
  it('recorded=false and ok=false when record does not persist a row', () => {
    // record is a no-op: rows array never grows
    const deps = makeDeps({ record: vi.fn(() => { /* noop */ }) })
    const result = runAiDefenceProbe(deps)
    expect(result.recorded).toBe(false)
    expect(result.ok).toBe(false)
  })

  it('recorded=false and does not throw when record throws', () => {
    const deps = makeDeps({ record: vi.fn(() => { throw new Error('DB full') }) })
    expect(() => runAiDefenceProbe(deps)).not.toThrow()
    const result = runAiDefenceProbe(deps)
    expect(result.recorded).toBe(false)
    expect(result.ok).toBe(false)
  })
})

// ---- from_agent scoping --------------------------------------------------

describe('runAiDefenceProbe -- from_agent scoping', () => {
  it('counts only rows with from_agent="aidefence-probe" for the recorded check', () => {
    // Rows from other agents should not inflate the count
    const foreignRow = makeRow({ from_agent: 'dave', id: 99 })
    let probeRowAdded = false
    const deps = makeDeps({
      record: vi.fn((_input, _nowSec) => { probeRowAdded = true }),
      getEvents: vi.fn((_limit?: number, _since?: number) => {
        if (probeRowAdded) return [makeRow(), foreignRow]
        return [foreignRow]
      }),
    })
    const result = runAiDefenceProbe(deps)
    expect(result.recorded).toBe(true)
  })
})
