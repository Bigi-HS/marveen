# Phase 1 — S3 slice brief (delegation-ready)

**For:** one ephemeral-eng worker (larger, ~M/L). **Gate:** Thor + Dave. **Owner-architect:** Dave — ping me at the PR, at the DB-schema step, and on the dedup/budget contract.
**Parent spec:** `docs/design/memory-continuity-phase1-impl-spec-0914.md` (NoA-approved). **Depends on S2** (the crash-gated replay path) — build after S2 merges, branch off the develop tip that includes S2.

## Goal (one sentence)
A durable per-agent **checkpoint** — a superset of task-state — that captures "what you can save" (recent turns, focus, a brain-dump bucket), survives crash/compact/restart via an FS file **and** a noa.db mirror, and replays on crash-resume WITHOUT double-injecting the ledger window.

## New module: `src/web/agent-checkpoint.ts`
Superset of task-state; does NOT replace `agent-taskstate.ts` yet (co-exists). Shape:
```
interface AgentCheckpoint {
  agent: string
  ts: number                    // epoch ms
  consumed: boolean
  focus: string                 // 1-line "what I'm doing"
  lastTurns: TurnPair[]         // last K verbatim in/out, K = 6
  pendingObservations: string[] // brain-dump bucket (STORE ONLY here — see below)
  // task-state fields folded in for the superset: doneSteps, alreadyDelegated, nextAction, pendingDecision, summary
}
```
- Storage: `store/agent-checkpoints/<agent>.json` (same dir S1 uses for `.shutdown`; a `.json` checkpoint is a different file). Atomic temp-rename write. TTL **48h**. Single-consume guard mirrored from task-state (`consumed` flag + `markConsumed`).
- **`lastTurns` hard char cap ~4k** (per NoA). Truncate oldest-first; a single turn over cap is head+tail elided. K=6.
- Pure helpers mirroring task-state: `shouldReplayCheckpoint(record, source, lastBoot, nowMs, ttl)` (same crash-gate logic as S2), `buildCheckpointInjection(record)`, `isEmptyCheckpoint(record)`. Keep IO out of the pure fns.

## Durability mirror (G2): noa.db `agent_checkpoints`
- **RUN the `database-designer` skill FIRST** for column conventions before writing the migration (NoA hard requirement). Match existing noa.db patterns (see `scripts/schema-noa.sql`): columns ≈ `agent_id TEXT`, `created_at INTEGER`, `consumed INTEGER`, `ttl_ms INTEGER`, plus the payload (focus, last_turns JSON, pending_observations JSON, task-state fields). Additive table only — no rebuild of existing tables. Target **noa.db** (live server DB), NOT the frozen `claudeclaw.db`.
- Write path: **throttled ≥ 30s** (avoid a write storm from the periodic tick). FS is the primary; the DB mirror is the crash-recovery backstop. On replay, if the FS file is missing/corrupt, fall back to the freshest unconsumed DB row.
- Migration lives with the module; verify it runs on prod noa.db (lesson: a fixture-created table that prod never migrates = false-green — assert the migration is in the real startup path + live-DB check).

## Triggers (G8)
1. **PreCompact** (reuse the existing agent-hook): also flush `pendingObservations` + a checkpoint. (The agent actually WRITING observations pre-compaction is Phase-4, not here — see below.)
2. **SessionEnd** (reuse the S1 SessionEnd hook path): stamp a final checkpoint alongside the clean-shutdown marker.
3. **Periodic mid-session tick:** piggyback the existing **UserPromptSubmit** ledger hook, **throttled** (no new timer, per NoA-approved cadence) so a hard crash still leaves a recent checkpoint.

## Replay + the DEDUP / COMBINED-BUDGET contract (NoA review requirement — do not skip)
Fold checkpoint replay into the **S2 crash-gate**: on a `startup` boot classified `'crash'`, the freshest UNCONSUMED checkpoint wins over bare task-state.
- **checkpoint `lastTurns` OVERLAPS the ledger-replay window** (both carry recent turns). On crash-resume BOTH would fire → double injection + SessionStart budget blowup. Required behavior:
  1. **Combined budget:** cap the TOTAL SessionStart continuity budget (ledger + task-state/checkpoint + memory-replay together) at ~5-6k, NOT per-source.
  2. **Suppression:** on crash-resume, the checkpoint `lastTurns` **SUPPRESSES/replaces** the ledger window for THAT boot — they must not stack. Verify the ledger-replay hook and the checkpoint-replay path coordinate (a shared flag/marker for "checkpoint already supplied the recent-turns window this boot").
- Single-consume: once injected + consumed, neither the checkpoint nor its DB row replays again.

## pendingObservations = STORE ONLY in S3
S3 builds the bucket (the container) and stores/injects it. The agent ACTUALLY dumping observations before compaction (a prompt / PreCompact-checklist change) is **Phase 4, tracked separately** — do NOT add prompt-side dumping logic in S3.

## Tests (TDD — write first)
- Pure-fn matrix for `shouldReplayCheckpoint` (mirror S2: lastBoot × source), `isEmptyCheckpoint`, `buildCheckpointInjection`, and the `lastTurns` char-cap/truncation (oldest-first, K=6, over-cap elision).
- Storage: atomic write, TTL 48h expiry, single-consume, corrupt-file → treated as absent (fail-open, not false-crash).
- DB mirror: throttle ≥30s honored; FS-missing → DB fallback returns freshest unconsumed row; migration present in the real startup path (live-DB assertion, not fixture-only).
- **Dedup/budget:** a crash-resume with BOTH a ledger window and a checkpoint `lastTurns` injects the recent-turns window ONCE and stays within the combined cap. This is the highest-value test — the whole slice's correctness hinges on it.
- Regression: task-state path unchanged when no checkpoint exists.

## Constraints
- Fail-open + atomic everywhere; a checkpoint write must NEVER throw into the agent turn.
- Safe direction inherited from S2: `unknown`/`clean` → no replay.
- `database-designer` before the migration. noa.db only.
- TDD → worktree+branch (`eng/mem-s1-s3-...` off the post-S2 develop tip) → PR → Thor+Dave gate → c12 sandbox → Forge deploy 4/4 verify. NOT shared develop directly.
- `change-impact-log.py` at PR (top-risk = double-injection / budget blowup on crash-resume; mitigated by the suppression+combined-budget contract).

## Blast radius
New module + new noa.db table + 3 hook trigger points, all fleet-wide → c12 mandatory. Larger than S2. Reversible: the DB table is additive (leave on rollback); revert the module + hook wiring. Build ONLY after S2 is merged so the crash-gate the replay depends on already exists.
