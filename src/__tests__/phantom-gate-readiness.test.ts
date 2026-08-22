import { describe, it, expect } from 'vitest'
import {
  isTestPass,
  evaluateGateReadiness,
  type PhantomResult,
} from '../phantom/gate-readiness.js'

// Card 4e5e529a (E2), slice 4 (final): decide whether a finished phantom branch
// is auto-fileable to the Thor+Dave gate. Pure over the result record the runner
// already collected (baseConfirmed + 1 commit + main clean + pushed + typecheck/
// tests pass + no file overrun); the git IO lives in the runner.

const clean = (over: Partial<PhantomResult> = {}): PhantomResult => ({
  key: 't1',
  baseConfirmed: true,
  commitCount: 1,
  filesChanged: ['src/web/agent-process.ts'],
  typecheck: 'pass',
  tests: 'pass - 12 tests',
  mainCheckoutClean: true,
  pushed: true,
  blockers: '',
  ...over,
})

const DECLARED = ['src/web/agent-process.ts']

describe('isTestPass', () => {
  it('accepts strings that start with pass (any casing/detail)', () => {
    expect(isTestPass('pass')).toBe(true)
    expect(isTestPass('pass - 22 tests green')).toBe(true)
    expect(isTestPass('  PASS (vitest) ')).toBe(true)
  })
  it('rejects fail / skipped / empty', () => {
    expect(isTestPass('fail: 1 test red')).toBe(false)
    expect(isTestPass('skipped')).toBe(false)
    expect(isTestPass('')).toBe(false)
  })
})

describe('evaluateGateReadiness', () => {
  it('files a fully clean result to gate', () => {
    const r = evaluateGateReadiness(clean(), DECLARED)
    expect(r.gateReady).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.overrun).toEqual([])
  })

  it('blocks when base was not confirmed', () => {
    const r = evaluateGateReadiness(clean({ baseConfirmed: false }), DECLARED)
    expect(r.gateReady).toBe(false)
    expect(r.blockers.some(b => /base/i.test(b))).toBe(true)
  })

  it('blocks when commitCount is not exactly 1', () => {
    expect(evaluateGateReadiness(clean({ commitCount: 0 }), DECLARED).gateReady).toBe(false)
    const r = evaluateGateReadiness(clean({ commitCount: 3 }), DECLARED)
    expect(r.gateReady).toBe(false)
    expect(r.blockers.some(b => /commit/i.test(b))).toBe(true)
  })

  it('blocks when main checkout is dirty', () => {
    const r = evaluateGateReadiness(clean({ mainCheckoutClean: false }), DECLARED)
    expect(r.gateReady).toBe(false)
    expect(r.blockers.some(b => /main|clean|drift/i.test(b))).toBe(true)
  })

  it('blocks when the branch was not pushed', () => {
    const r = evaluateGateReadiness(clean({ pushed: false }), DECLARED)
    expect(r.gateReady).toBe(false)
    expect(r.blockers.some(b => /push/i.test(b))).toBe(true)
  })

  it('blocks on a failing or skipped typecheck', () => {
    expect(evaluateGateReadiness(clean({ typecheck: 'fail' }), DECLARED).gateReady).toBe(false)
    expect(evaluateGateReadiness(clean({ typecheck: 'skipped' }), DECLARED).gateReady).toBe(false)
  })

  it('blocks on failing tests', () => {
    const r = evaluateGateReadiness(clean({ tests: 'fail: 2 red' }), DECLARED)
    expect(r.gateReady).toBe(false)
    expect(r.blockers.some(b => /test/i.test(b))).toBe(true)
  })

  it('blocks and reports overrun when a changed file is outside declared globs', () => {
    const r = evaluateGateReadiness(
      clean({ filesChanged: ['src/web/agent-process.ts', 'src/secret.ts'] }),
      DECLARED,
    )
    expect(r.gateReady).toBe(false)
    expect(r.overrun).toEqual(['src/secret.ts'])
    expect(r.blockers.some(b => /overrun|declared/i.test(b))).toBe(true)
  })

  it('honors glob declarations (no overrun within the glob)', () => {
    const r = evaluateGateReadiness(
      clean({ filesChanged: ['src/web/a.ts', 'src/web/b.ts'] }),
      ['src/web/*.ts'],
    )
    expect(r.gateReady).toBe(true)
  })

  it('surfaces a non-empty runner blockers field', () => {
    const r = evaluateGateReadiness(clean({ blockers: 'could not run integration suite' }), DECLARED)
    expect(r.gateReady).toBe(false)
    expect(r.blockers.some(b => /integration suite/.test(b))).toBe(true)
  })

  it('collects ALL blockers at once', () => {
    const r = evaluateGateReadiness(
      clean({ baseConfirmed: false, pushed: false, typecheck: 'fail', commitCount: 2 }),
      DECLARED,
    )
    expect(r.gateReady).toBe(false)
    expect(r.blockers.length).toBeGreaterThanOrEqual(4)
  })
})
