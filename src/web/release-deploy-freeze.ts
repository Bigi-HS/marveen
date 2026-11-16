// Conservative planning-freeze resolution for the release-deploy path (card
// 2efcb439, v2-spec-p9-sandbox-release.md §8 Inv-8, Thor MINOR-B). Slice 4b.
//
// WHY A DEPLOY-SPECIFIC RESOLVER (not planning-freeze.ts's freezeBlocks):
// the agent-respawn gate (planning-freeze.ts / fleet-supervisor.sh) fails SAFE
// toward ALLOW -- an over-eager block would wrongly suppress a keep-list agent.
// The DEPLOY gate must fail the OTHER way: an irreversible auto-deploy during a
// planning freeze is the dangerous outcome, so uncertainty must resolve to SKIP.
// Reason (spec §8 / DA-T0-2): the fix-window job runs OUTSIDE the session
// chokepoint the server-side freeze governs (the planning-freeze-server-respawn-
// leak class), so it is an un-gated deploy-authority unless it independently and
// CONSERVATIVELY checks the freeze before shipping.
//
// CONSERVATIVE, NOT AN OR (Thor MINOR-B): the silence of either source must never
// become a silent bypass. A deploy is SUPPRESSED unless we hold a POSITIVE
// authoritative "not frozen" signal:
//   - server freeze-API authoritative: when reachable, its answer is used; BUT a
//     present (or unreadable) flag file still forces SKIP even on a not-frozen API
//     answer, so neither source's state can be ignored.
//   - API unreachable: fall back to the file. presence = SKIP; an unreachable
//     authoritative API means we have NO positive confirmation of no-freeze, so we
//     SKIP regardless of the file ("hiány != automatikus zöld" -- absence is not
//     an automatic green without authority). The file can only ADD a SKIP, never
//     grant a GO.
//
// The flag file is the SAME one the agent-respawn gate reads
// (store/planning-freeze.enabled), so there is ONE freeze contract across layers.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'

// Computed lazily (not at module load) so merely importing has no side effect and
// so tests that mock STORE_DIR see the mocked value -- mirrors planning-freeze.ts.
const freezeFlagPath = (): string => join(STORE_DIR, 'planning-freeze.enabled')

export type FileFreezeState = 'present' | 'absent' | 'uncertain'

// Tri-state file read. Unlike planningFreezeEnabled() (which collapses uncertain
// to false, fail-safe toward ALLOW), the deploy path needs to distinguish a clear
// absence from an unreadable filesystem so it can SKIP on uncertainty.
export function readFreezeFileState(): FileFreezeState {
  try {
    return existsSync(freezeFlagPath()) ? 'present' : 'absent'
  } catch {
    return 'uncertain'
  }
}

export interface FreezeProbeResult {
  // false when the authoritative server freeze-API could not be consulted (e.g.
  // the out-of-process cron job cannot reach the dashboard server).
  reachable: boolean
  frozen: boolean
}

// The authoritative server freeze-API probe for the out-of-process (cron
// fix-window) path. Injected so the resolver is testable and so the in-server
// manual path -- which has no network hop and reads the flag authoritatively
// in-process -- can omit it. The real HTTP probe lands with the §6 cron loop.
export type FreezeProbe = () => Promise<FreezeProbeResult> | FreezeProbeResult

// Resolve whether the deploy must be SKIPped for a planning freeze. Returns true
// to SUPPRESS the deploy (the deployGate maps this to code 'planning_freeze').
export async function resolveDeployFreeze(probe?: FreezeProbe): Promise<boolean> {
  const file = readFreezeFileState()

  if (probe) {
    let api: FreezeProbeResult | null = null
    try {
      api = await probe()
    } catch {
      api = null // a throwing probe is treated as unreachable (conservative)
    }
    if (api && api.reachable) {
      if (api.frozen) return true // authoritative freeze -> SKIP
      // API authoritatively not-frozen: a lingering/unreadable flag file still
      // suppresses (both sources consulted); a clear absence allows the deploy.
      return file !== 'absent'
    }
    // Probe supplied but unreachable: no authoritative confirmation of no-freeze.
    // Conservative SKIP -- the file can only reinforce this, never override it.
    return true
  }

  // No probe (in-server manual path): the flag file is authoritative in-process.
  // present | uncertain -> SKIP; a clear absence allows the deploy.
  return file !== 'absent'
}
