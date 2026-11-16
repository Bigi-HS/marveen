// Real Inv-10 post-deploy canary (card 2efcb439, v2-spec-p9-sandbox-release.md
// §7/§12, slice 4c-1). Fills the `canary` seam that deployRelease injects
// (release-pipeline.ts): after the executor restarts the live server, this
// observes the running build and returns healthy=false to drive the
// deterministic auto-rollback. D2=AUTO removed the closing human, so the signal
// must be mechanical -- no LLM judgement.
//
// The canary does two things over a fixed observation window (spec: 120s):
//   1. samples a lightweight P0 health signal repeatedly across the window, and
//   2. confirms the mechanical 4-point deploy-verify (GET /api/gate/verify) once
//      at the end.
// A P0 error is an unreachable server (transport failure, status 0) or a 5xx --
// a server fault. A 4xx is NOT a P0 (it is a client/auth condition, and the
// admin-scoped verify already covers auth). healthy requires the 4-point verify
// to return 200 AND the P0 error-rate to be at or under maxErrorRate.
//
// Both HTTP probes and the inter-sample sleep are INJECTED so the window logic is
// deterministic and proven with zero real I/O. The real probes (node http to
// localhost:WEB_PORT with the admin token) are constructed + reviewed at the
// assembly boundary, keeping this module pure window/threshold logic.

import type { CanaryCheck, CanaryResult } from './release-pipeline.js'

// A single HTTP probe outcome. status 0 means the request never completed
// (transport error / server not listening); any real HTTP status is passed
// through verbatim.
export interface ProbeSample {
  status: number
}

export interface CanaryProbeDeps {
  // The authoritative mechanical 4-point check (GET /api/gate/verify). 200 = pass;
  // 503 = at least one of F1-F4 failed; 0 = the server never answered.
  verify: () => Promise<ProbeSample>
  // A lightweight liveness sample taken repeatedly across the window.
  sample: () => Promise<ProbeSample>
  // Injected sleep between samples (deterministic in tests; real setTimeout live).
  sleep: (ms: number) => Promise<void>
}

export interface CanaryConfig {
  // Total observation window.
  windowMs: number
  // Spacing between P0 samples. The sample count is ceil(windowMs/sampleIntervalMs),
  // floored at 1, so the window is always observed at least once.
  sampleIntervalMs: number
  // Maximum tolerated P0 error fraction in [0,1]. A rate strictly above this is
  // unhealthy. Default 0: an unattended auto-deploy tolerates no server fault,
  // because a rollback is safe/reversible and missing a bad deploy is not.
  maxErrorRate: number
}

export const DEFAULT_CANARY_CONFIG: CanaryConfig = {
  windowMs: 120_000,
  sampleIntervalMs: 10_000,
  maxErrorRate: 0,
}

// A P0 error = the server did not answer (0) or answered with a server fault (5xx).
function isP0Error(status: number): boolean {
  return status === 0 || status >= 500
}

// Build a CanaryCheck (the shape deployRelease's `canary` dep expects) bound to
// the given probes + config.
export function makeDeployCanary(deps: CanaryProbeDeps, config: CanaryConfig = DEFAULT_CANARY_CONFIG): CanaryCheck {
  return async (): Promise<CanaryResult> => {
    const sampleCount = Math.max(1, Math.ceil(config.windowMs / config.sampleIntervalMs))
    let p0Errors = 0
    for (let i = 0; i < sampleCount; i++) {
      const s = await deps.sample()
      if (isP0Error(s.status)) p0Errors += 1
      // Sleep between samples, but never after the last one.
      if (i < sampleCount - 1) {
        await deps.sleep(config.sampleIntervalMs)
      }
    }

    const verify = await deps.verify()
    const errorRate = p0Errors / sampleCount
    const healthy = verify.status === 200 && errorRate <= config.maxErrorRate

    const detail =
      `verify=${verify.status} p0=${p0Errors}/${sampleCount} ` +
      `(rate=${errorRate.toFixed(3)}, max=${config.maxErrorRate})`

    return { healthy, detail }
  }
}
