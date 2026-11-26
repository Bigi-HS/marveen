// Live deploy-path driver (card 2efcb439, v2-spec-p9-sandbox-release.md §7/§8).
// Slice 4b: the Inv-8 freeze LIVE-WIRING. Slice 4c-5: single-live-entry serialization.
//
// deployRelease() carries the planning-freeze gate (Inv-8) but takes
// planningFreezeActive as an INPUT -- on its own the predicate is inert until a
// real caller actually feeds it from the conservative source. This driver is that
// caller. It resolves the freeze state HERE, from the real source
// (release-deploy-freeze.ts), and passes it into the shared gate, closing the
// "merged but unwired" gap (the same trap as the egress-PII hook: a predicate that
// exists but is never fed on the live path).
//
// Both deploy triggers converge here (Inv-5): the dashboard manual quick-build
// (in-server, no freeze probe -- the flag file is authoritative in-process) and
// the cron fix-window job (out-of-process, supplies a server freeze-API probe).
// The freeze is deliberately NOT part of the injected IO -- injecting it would
// re-open the unwired gap. Only the mechanics (executor + the Inv-10 safety net)
// are injected; the real build/restart executor, the real canary
// (fleet-deploy-verify 4-point + P0 error-rate), rollback.sh, and the Boss alert
// are wired at this boundary in the following slice.
//
// SINGLE-LIVE-ENTRY (G4 deploy-lock, §12 Verify-16): this is the SINGLE live deploy
// entry point, and it is SERIALIZED. A live deploy performs real, globally-shared,
// non-reentrant work (git checkout, dist.backup-* snapshot, tmux restart); two
// deploys interleaving would corrupt each other's filesystem/git state regardless
// of which ledger row each targets. The dashboard server is a single process, so a
// process-wide in-memory mutex is the correct lock: the loser WAITS (the spec's "a
// vesztes var") rather than racing. The chain is finally-released even when the
// deploy throws or rejects, so a failed deploy never deadlocks the next one.

import type Database from 'better-sqlite3'
import {
  deployRelease,
  type DeployTrigger,
  type DeployResult,
  type DeployDeps,
} from './release-pipeline.js'
import { resolveDeployFreeze, type FreezeProbe } from './release-deploy-freeze.js'

export interface LiveDeployParams {
  trigger: DeployTrigger
  // Fresh Boss-GO click confirmation (manual trigger only).
  manualBossGoClick?: boolean
}

export interface LiveDeployIO {
  // Injected for deterministic ledger stamps (the real caller passes Date.now()).
  nowMs: number
  // The real build/rsync/restart. For a 'window' deploy the Inv-10 safety net
  // (canary + rollback + alert) is mandatory and enforced inside deployRelease.
  executor: DeployDeps['executor']
  canary?: DeployDeps['canary']
  rollback?: DeployDeps['rollback']
  alert?: DeployDeps['alert']
  // Authoritative server freeze-API probe for the out-of-process cron path. The
  // in-server manual path omits it (its in-process flag read is authoritative).
  freezeProbe?: FreezeProbe
}

// Process-wide deploy serialization chain (G4 deploy-lock). deployChain always
// holds the tail of the queue of in-flight/pending live deploys; each new deploy
// awaits the previous tail before starting, so at most one live deploy runs at a
// time. A deploy that throws is swallowed HERE (via .catch) only for the purpose
// of unblocking the chain -- the caller still receives the real rejection/result
// from its own promise. The chain can never be stuck by a failed deploy.
let deployChain: Promise<void> = Promise.resolve()

// Serialize fn behind the current deploy chain. Returns fn's result/rejection to
// the caller while advancing the chain (which only tracks completion, not value).
function serializeDeploy<T>(fn: () => Promise<T>): Promise<T> {
  const run = deployChain.then(fn)
  // Advance the chain on completion of THIS deploy, success or failure, so the
  // lock is always released (no deadlock on a thrown/rejected deploy).
  deployChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

// The single live deploy entry point. SERIALIZED (G4): if another live deploy is
// in flight, this one WAITS for it before resolving the freeze and running the
// shared gate+deploy path -- the dawn fix-window job and a manual quick-build can
// never race on the shared git/dist.backup-* state. Resolves the planning-freeze
// state from the real conservative source, then runs the shared gate+deploy path.
// A freeze suppresses the deploy here, THROUGH this caller -- deployGate returns
// 'planning_freeze' and the executor never runs.
export async function runLiveDeploy(
  db: Database.Database,
  ledgerId: number,
  params: LiveDeployParams,
  io: LiveDeployIO
): Promise<DeployResult> {
  return serializeDeploy(async () => {
    const planningFreezeActive = await resolveDeployFreeze(io.freezeProbe)

    return deployRelease(
      db,
      ledgerId,
      {
        trigger: params.trigger,
        manualBossGoClick: params.manualBossGoClick,
        planningFreezeActive,
      },
      {
        nowMs: io.nowMs,
        executor: io.executor,
        canary: io.canary,
        rollback: io.rollback,
        alert: io.alert,
      }
    )
  })
}
