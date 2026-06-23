// Card 9118c069: the phantom-runner planner that composes the four E2 building
// blocks into an execution plan for the thin Workflow-JS executor. Pure -- no
// IO (manifest reading lives in scripts/phantom-plan.ts), so every planning
// decision is unit-tested directly.

import { describe, it, expect } from 'vitest'
import {
  planManifest,
  computeWaves,
  buildPhantomPrompt,
  evaluatePhantomResults,
  PHANTOM_RESULT_SCHEMA,
  DEFAULT_PHANTOM_MODEL,
  type ExecutionPlan,
} from '../phantom/runner.js'
import type { ParsedTask } from '../phantom/manifest-parse.js'
import type { PhantomResult } from '../phantom/gate-readiness.js'

// Minimal raw manifest task (the executor schema fields). Optional fields
// default in parseManifestTask (depends_on=[], conflicts_with=[], parallel=true).
function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a',
    card: 'card-a',
    title: 'Task A',
    body: 'do the thing',
    files_touched: ['src/a.ts'],
    ...over,
  }
}

// A fully-parsed task for computeWaves tests.
function parsed(over: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id: 'a',
    card: 'card-a',
    title: 'A',
    body: 'b',
    files_touched: ['src/a.ts'],
    depends_on: [],
    conflicts_with: [],
    parallel: true,
    ...over,
  }
}

const okPlan = (r: ReturnType<typeof planManifest>): ExecutionPlan => {
  if (!r.ok) throw new Error('expected ok plan, got errors: ' + r.errors.join('; '))
  return r
}

describe('planManifest', () => {
  it('produces a plan with a rendered prompt + schema for a valid manifest', () => {
    const plan = okPlan(planManifest([raw({ id: 'x', files_touched: ['src/x.ts'] })]))
    expect(plan.tasks).toHaveLength(1)
    expect(plan.tasks[0].id).toBe('x')
    expect(plan.tasks[0].model).toBe(DEFAULT_PHANTOM_MODEL)
    expect(plan.tasks[0].prompt).toContain('eng/eph-x')
    expect(plan.schema).toBe(PHANTOM_RESULT_SCHEMA)
    expect(plan.waves).toEqual([['x']])
    expect(plan.conflicts).toEqual([])
  })

  it('does NOT leak the raw body field onto the planned task (prompt only)', () => {
    const plan = okPlan(planManifest([raw()]))
    expect(plan.tasks[0]).not.toHaveProperty('body')
    expect(plan.tasks[0].prompt).toContain('do the thing')
  })

  it('honours repo + model options', () => {
    const plan = okPlan(planManifest([raw()], { repo: '/srv/app', model: 'claude-opus-4-8' }))
    expect(plan.repo).toBe('/srv/app')
    expect(plan.tasks[0].model).toBe('claude-opus-4-8')
    expect(plan.tasks[0].prompt).toContain('/srv/app/store/fleet-eng-context.md')
  })

  it('collects parse errors across all tasks in one pass (and fails)', () => {
    const r = planManifest([raw(), { id: '', card: '', title: '', body: '', files_touched: [] }])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some(e => e.startsWith('task[1]:'))).toBe(true)
      expect(r.errors.some(e => /required non-empty string/.test(e))).toBe(true)
    }
  })

  it('rejects a manifest with a duplicate id', () => {
    const r = planManifest([raw({ id: 'dup' }), raw({ id: 'dup', files_touched: ['src/b.ts'] })])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some(e => /duplicate id: dup/.test(e))).toBe(true)
  })

  it('rejects an unknown depends_on reference', () => {
    const r = planManifest([raw({ id: 'a', depends_on: ['ghost'] })])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some(e => /unknown id: ghost/.test(e))).toBe(true)
  })

  it('rejects a dependency cycle', () => {
    const r = planManifest([
      raw({ id: 'a', depends_on: ['b'], files_touched: ['src/a.ts'] }),
      raw({ id: 'b', depends_on: ['a'], files_touched: ['src/b.ts'] }),
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some(e => /dependency cycle/.test(e))).toBe(true)
  })

  it('orders dependents into a later wave than their dependency', () => {
    const plan = okPlan(planManifest([
      raw({ id: 'build', files_touched: ['src/build.ts'] }),
      raw({ id: 'deploy', depends_on: ['build'], files_touched: ['src/deploy.ts'] }),
    ]))
    expect(plan.waves[0]).toContain('build')
    expect(plan.waves[1]).toEqual(['deploy'])
  })

  it('auto-serialises file-overlapping parallel tasks into separate waves and reports the conflict', () => {
    const plan = okPlan(planManifest([
      raw({ id: 'a', files_touched: ['src/shared.ts'] }),
      raw({ id: 'b', files_touched: ['src/shared.ts'] }),
    ]))
    // They overlap on src/shared.ts -> never in the same wave.
    for (const wave of plan.waves) {
      expect(wave.includes('a') && wave.includes('b')).toBe(false)
    }
    expect(plan.conflicts).toEqual([{ a: 'a', b: 'b', reason: 'files-overlap' }])
    // Every task still scheduled exactly once.
    expect(plan.waves.flat().sort()).toEqual(['a', 'b'])
  })

  it('reports a declared conflict (conflicts_with) and serialises it', () => {
    const plan = okPlan(planManifest([
      raw({ id: 'a', conflicts_with: ['b'], files_touched: ['src/a.ts'] }),
      raw({ id: 'b', files_touched: ['src/b.ts'] }),
    ]))
    expect(plan.conflicts).toEqual([{ a: 'a', b: 'b', reason: 'declared-conflict' }])
    expect(plan.waves.flat().sort()).toEqual(['a', 'b'])
  })
})

describe('computeWaves', () => {
  it('puts independent non-conflicting tasks in a single wave', () => {
    const waves = computeWaves([
      parsed({ id: 'a', files_touched: ['src/a.ts'] }),
      parsed({ id: 'b', files_touched: ['src/b.ts'] }),
      parsed({ id: 'c', files_touched: ['src/c.ts'] }),
    ])
    expect(waves).toHaveLength(1)
    expect(waves[0].sort()).toEqual(['a', 'b', 'c'])
  })

  it('runs a parallel:false task alone in its own wave', () => {
    const waves = computeWaves([
      parsed({ id: 'a', files_touched: ['src/a.ts'] }),
      parsed({ id: 'solo', parallel: false, files_touched: ['src/solo.ts'] }),
      parsed({ id: 'b', files_touched: ['src/b.ts'] }),
    ])
    const soloWave = waves.find(w => w.includes('solo'))!
    expect(soloWave).toEqual(['solo'])
  })

  it('schedules every task exactly once across the waves', () => {
    const waves = computeWaves([
      parsed({ id: 'a', files_touched: ['src/a.ts'] }),
      parsed({ id: 'b', depends_on: ['a'], files_touched: ['src/b.ts'] }),
      parsed({ id: 'c', depends_on: ['b'], files_touched: ['src/c.ts'] }),
    ])
    expect(waves).toEqual([['a'], ['b'], ['c']])
  })
})

describe('buildPhantomPrompt', () => {
  const t = { id: 'k1', card: 'card-9', title: 'Fix the thing', body: 'detailed body here', files_touched: ['src/x.ts', 'src/y.ts'] }

  it('embeds card, title, body, branch and the declared globs', () => {
    const p = buildPhantomPrompt(t, '/home/domin/marveen')
    expect(p).toContain('card-9')
    expect(p).toContain('Fix the thing')
    expect(p).toContain('detailed body here')
    expect(p).toContain('eng/eph-k1')
    expect(p).toContain('src/x.ts, src/y.ts')
  })

  it('keeps the never-open-a-PR + pin-base-to-develop guardrails', () => {
    const p = buildPhantomPrompt(t, '/repo')
    expect(p).toContain('NEVER open a PR')
    expect(p).toContain('checkout -B eng/eph-k1 origin/develop')
    expect(p).toContain('/repo/store/fleet-eng-context.md')
  })
})

describe('evaluatePhantomResults', () => {
  const base: PhantomResult = {
    key: 'a',
    baseConfirmed: true,
    commitCount: 1,
    filesChanged: ['src/a.ts'],
    typecheck: 'pass',
    tests: 'pass (src/a.test.ts)',
    mainCheckoutClean: true,
    pushed: true,
  }
  const tasks = [{ id: 'a', files_touched: ['src/a.ts'] }, { id: 'b', files_touched: ['src/b.ts'] }]

  it('marks a clean in-scope result gate-ready', () => {
    const out = evaluatePhantomResults([base], tasks)
    expect(out[0]).toEqual({ key: 'a', decision: { gateReady: true, blockers: [], overrun: [] } })
  })

  it('flags an overrun (changed a file outside the declared globs)', () => {
    const out = evaluatePhantomResults([{ ...base, filesChanged: ['src/a.ts', 'src/secret.ts'] }], tasks)
    expect(out[0].decision.gateReady).toBe(false)
    expect(out[0].decision.overrun).toEqual(['src/secret.ts'])
  })

  it('flags a dirty result (failed typecheck, >1 commit)', () => {
    const out = evaluatePhantomResults([{ ...base, typecheck: 'fail', commitCount: 3 }], tasks)
    expect(out[0].decision.gateReady).toBe(false)
    expect(out[0].decision.blockers.length).toBeGreaterThanOrEqual(2)
  })

  it('treats an unknown key as zero declared globs (any change = overrun)', () => {
    const out = evaluatePhantomResults([{ ...base, key: 'mystery' }], tasks)
    expect(out[0].decision.gateReady).toBe(false)
    expect(out[0].decision.overrun).toEqual(['src/a.ts'])
  })
})
