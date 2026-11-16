// Tests for the REAL Inv-10 post-deploy canary (card 2efcb439,
// v2-spec-p9-sandbox-release.md §7/§12, slice 4c-1). The canary observes the
// just-restarted live server: it samples a P0 health signal across a fixed
// observation window (spec: 120s) and confirms the mechanical 4-point
// deploy-verify (GET /api/gate/verify) at the end. An unreachable server or a
// P0 error-rate above threshold or a failing 4-point check yields healthy=false,
// which drives the deterministic auto-rollback in deployRelease.
//
// The HTTP probes and the window sleep are INJECTED so the window logic is proven
// deterministically with zero real I/O and zero wall-clock wait -- the real HTTP
// construction (localhost:WEB_PORT + admin token) is wired + reviewed in the
// assembly slice. A canary gating an UNATTENDED auto-rollback is deliberately
// strict: a rollback is safe/reversible, so a false alarm is cheaper than missing
// a bad deploy (default maxErrorRate=0, zero P0 tolerance).

import { describe, it, expect } from 'vitest'
import {
  makeDeployCanary,
  DEFAULT_CANARY_CONFIG,
  type CanaryProbeDeps,
  type CanaryConfig,
} from '../web/release-canary-probe.js'

// A deterministic probe harness. `verifyStatus` is the final 4-point status;
// `sampleStatuses` is consumed one-per-sample (last value repeats if exhausted).
function harness(opts: {
  verifyStatus: number
  sampleStatuses: number[]
}): { deps: CanaryProbeDeps; sampleCalls: number; sleepCalls: number[] } {
  const state = { sampleIdx: 0, sampleCalls: 0, sleepCalls: [] as number[] }
  const deps: CanaryProbeDeps = {
    verify: async () => ({ status: opts.verifyStatus }),
    sample: async () => {
      const i = Math.min(state.sampleIdx, opts.sampleStatuses.length - 1)
      state.sampleIdx += 1
      state.sampleCalls += 1
      return { status: opts.sampleStatuses[i] }
    },
    sleep: async (ms: number) => {
      state.sleepCalls.push(ms)
    },
  }
  return {
    deps,
    get sampleCalls() {
      return state.sampleCalls
    },
    get sleepCalls() {
      return state.sleepCalls
    },
  } as { deps: CanaryProbeDeps; sampleCalls: number; sleepCalls: number[] }
}

// windowMs/sampleIntervalMs -> ceil(window/interval) samples, min 1.
const fastCfg: CanaryConfig = { windowMs: 120, sampleIntervalMs: 10, maxErrorRate: 0 }

describe('makeDeployCanary -- healthy path', () => {
  it('verify 200 + all samples 200 -> healthy', async () => {
    const h = harness({ verifyStatus: 200, sampleStatuses: [200] })
    const result = await makeDeployCanary(h.deps, fastCfg)()
    expect(result.healthy).toBe(true)
    expect(result.detail).toMatch(/verify=200/)
    expect(result.detail).toMatch(/p0=0\//)
  })

  it('takes ceil(windowMs/intervalMs) samples and sleeps between them (no trailing sleep)', async () => {
    const h = harness({ verifyStatus: 200, sampleStatuses: [200] })
    await makeDeployCanary(h.deps, fastCfg)()
    expect(h.sampleCalls).toBe(12) // ceil(120/10)
    expect(h.sleepCalls.length).toBe(11) // one fewer than samples
    expect(h.sleepCalls.every((ms) => ms === 10)).toBe(true)
  })

  it('always takes at least one sample even if window < interval', async () => {
    const h = harness({ verifyStatus: 200, sampleStatuses: [200] })
    await makeDeployCanary(h.deps, { windowMs: 1, sampleIntervalMs: 10, maxErrorRate: 0 })()
    expect(h.sampleCalls).toBe(1)
    expect(h.sleepCalls.length).toBe(0)
  })
})

describe('makeDeployCanary -- unhealthy paths', () => {
  it('failing 4-point verify (503) -> unhealthy even with clean samples', async () => {
    const h = harness({ verifyStatus: 503, sampleStatuses: [200] })
    const result = await makeDeployCanary(h.deps, fastCfg)()
    expect(result.healthy).toBe(false)
    expect(result.detail).toMatch(/verify=503/)
  })

  it('unreachable server (verify status 0) -> unhealthy', async () => {
    const h = harness({ verifyStatus: 0, sampleStatuses: [200] })
    const result = await makeDeployCanary(h.deps, fastCfg)()
    expect(result.healthy).toBe(false)
    expect(result.detail).toMatch(/verify=0/)
  })

  it('a single P0 error (500) with zero-tolerance -> unhealthy despite verify 200', async () => {
    const h = harness({ verifyStatus: 200, sampleStatuses: [200, 500, 200] })
    const result = await makeDeployCanary(h.deps, fastCfg)()
    expect(result.healthy).toBe(false)
    expect(result.detail).toMatch(/p0=1\//)
  })

  it('an unreachable sample (status 0) counts as a P0 error', async () => {
    const h = harness({ verifyStatus: 200, sampleStatuses: [0] })
    const result = await makeDeployCanary(h.deps, fastCfg)()
    expect(result.healthy).toBe(false)
    expect(result.detail).toMatch(/p0=12\//)
  })

  it('a 4xx sample is NOT a P0 error (client/auth, not a server fault)', async () => {
    const h = harness({ verifyStatus: 200, sampleStatuses: [404] })
    const result = await makeDeployCanary(h.deps, fastCfg)()
    expect(result.healthy).toBe(true)
    expect(result.detail).toMatch(/p0=0\//)
  })
})

describe('makeDeployCanary -- error-rate threshold', () => {
  it('P0 error within a non-zero threshold -> healthy', async () => {
    // 1 of 12 samples errors = 0.0833 rate, under a 0.2 threshold.
    const h = harness({ verifyStatus: 200, sampleStatuses: [500, 200] })
    const result = await makeDeployCanary(h.deps, {
      windowMs: 120,
      sampleIntervalMs: 10,
      maxErrorRate: 0.2,
    })()
    expect(result.healthy).toBe(true)
    expect(result.detail).toMatch(/p0=1\/12/)
  })

  it('P0 error-rate strictly above threshold -> unhealthy', async () => {
    // all 12 samples error = rate 1.0 > 0.2.
    const h = harness({ verifyStatus: 200, sampleStatuses: [500] })
    const result = await makeDeployCanary(h.deps, {
      windowMs: 120,
      sampleIntervalMs: 10,
      maxErrorRate: 0.2,
    })()
    expect(result.healthy).toBe(false)
  })
})

describe('makeDeployCanary -- contract', () => {
  it('default config is the spec 120s window / 10s interval / zero tolerance', () => {
    expect(DEFAULT_CANARY_CONFIG.windowMs).toBe(120_000)
    expect(DEFAULT_CANARY_CONFIG.sampleIntervalMs).toBe(10_000)
    expect(DEFAULT_CANARY_CONFIG.maxErrorRate).toBe(0)
  })

  it('returns a CanaryCheck-compatible async thunk (healthy + detail)', async () => {
    const h = harness({ verifyStatus: 200, sampleStatuses: [200] })
    const check = makeDeployCanary(h.deps, fastCfg)
    const result = await check()
    expect(typeof result.healthy).toBe('boolean')
    expect(typeof result.detail).toBe('string')
  })
})
