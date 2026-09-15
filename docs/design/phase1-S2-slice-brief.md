# Phase 1 — S2 slice brief (delegation-ready)

**For:** one ephemeral-eng worker. **Gate:** Thor + Dave. **Owner-architect:** Dave (me) — ping me at the PR and on any contract question.
**Parent spec:** `docs/design/memory-continuity-phase1-impl-spec-0914.md` (NoA-approved). This brief is the concrete build order; do not diverge from the spec without Dave sign-off.
**Prereq:** S1 is merged (origin/develop ae2baae). Branch FROM origin/develop (which has `src/web/shutdown-marker.ts`), never from live 531be26.

## Goal (one sentence)
Make the SessionStart task-state replay fire on a **cold `startup`** — but ONLY when S1's per-agent crash-marker says the previous session **crashed**. A normal fresh boot must keep today's behavior (no stale replay).

## What exists (read, do not rebuild)
- `src/web/shutdown-marker.ts` (S1, merged): `classifyLastBoot(marker, nowMs, ttl) -> 'clean'|'crash'|'unknown'` (PURE), `classifyAndConsume(agent, nowMs, ttl) -> BootClass` (read+classify+delete in one call), `SHUTDOWN_MARKER_TTL_MS`. Absent marker = `'crash'`; stale/malformed = `'unknown'`. `'clean'` and `'unknown'` suppress replay; only `'crash'` resumes.
- `src/web/agent-taskstate.ts`: `shouldReplayTaskState(record, source, nowMs, ttlMs) -> boolean` (PURE). Today: `REPLAY_SOURCES = new Set(['compact','resume'])`; a `'startup'` source returns false.
- `src/web/routes/agent-taskstate.ts` GET `/api/agent-taskstate/:agent/replay`: reads `source` from `url.searchParams.get('source')`, calls `shouldReplayTaskState(record, source, Date.now())`, returns `{additionalContext}`. **This is the wire point.**
- SessionStart hook `scripts/hooks/taskstate-replay.py` supplies `source` (the CC session source: `startup`/`compact`/`resume`).

## The change

### 1. Pure-fn extension (`src/web/agent-taskstate.ts`)
Add a `lastBoot: BootClass` parameter to `shouldReplayTaskState`:
```
export function shouldReplayTaskState(
  record: AgentTaskState | null,
  source: string,
  lastBoot: BootClass,          // NEW
  nowMs: number,
  ttlMs: number = TASKSTATE_TTL_MS,
): boolean
```
Import `BootClass` from `./shutdown-marker.js`. Logic:
- Keep every existing guard (record exists, !consumed, within TTL, !empty).
- Source eligibility becomes: `source ∈ {compact, resume}` **OR** (`source === 'startup'` **AND** `lastBoot === 'crash'`).
- `clean` / `unknown` on a `startup` source → false (today's behavior, the safe default).
- **Param ordering:** put `lastBoot` before `nowMs` so the existing default-arg callers that pass `(record, source, Date.now())` FAIL TO COMPILE — that is intentional, it forces every caller to be revisited. Do not give `lastBoot` a default.

### 2. Wire the marker at the route (`src/web/routes/agent-taskstate.ts`)
In the `/replay` GET handler, compute the boot class from S1 and pass it in:
```
const lastBoot = classifyAndConsume(agent, Date.now())   // reads+consumes the S1 marker
const inject = shouldReplayTaskState(record, source, lastBoot, Date.now()) ? buildTaskStateInjection(record!) : null
```
- Import `classifyAndConsume` from `../shutdown-marker.js`.
- **Consume-once ordering matters:** `classifyAndConsume` DELETES the marker. That is correct here (the replay endpoint is the single SessionStart read). But confirm no other caller reads the marker in the same boot, or the second reader would see `'crash'` (absent). Today only `/replay` reads it → fine. Document this invariant in a comment.

## OPEN DESIGN DECISION — marveen MAIN session classification (MUST resolve before merge)
The marveen MAIN session runs from the **project-root CWD**, not from `agents/marveen/`. Two sub-questions the worker must answer with a code-read BEFORE implementing, and raise to Dave/NoA with findings:
1. **Does marveen's SessionEnd hook actually stamp a marker, and under which `agent` key?** S1 added the SessionEnd hook to marveen's tracked `.claude/settings.json`, but verify what agent-id `session-end-marker.py` resolves for the main session (MAIN_AGENT_ID='marveen' vs a CWD/empty value). If it stamps under `'marveen'`, the marker path is `store/agent-checkpoints/marveen.shutdown`.
2. **Does marveen's `/replay` call use the same `agent` key?** Trace `taskstate-replay.py` for the main session: what `:agent` and `source` does it send? If the SessionEnd-stamp key and the SessionStart-read key differ, marveen would ALWAYS classify as `'crash'` (absent marker) → false resume on every normal boot — the exact anti-goal.

**Options (Dave's lean = A):**
- **(A) Symmetric same-key.** Ensure marveen stamps and reads under the identical agent key. If already symmetric, S2 needs no marveen-special-case — just verify with a test. Preferred: least surprise, one code path.
- **(B) Explicit marveen exclusion.** If the main session cannot get a reliable per-agent marker, treat marveen's `startup` as `'unknown'` (no replay) until a dedicated main-session marker exists. Safe but leaves marveen without crash-resume (acceptable stopgap; note it as a follow-up).
- Do NOT ship a version where marveen silently reads a never-written marker as `'crash'`.

## Tests (TDD — write first)
- Extend the existing `shouldReplayTaskState` matrix: for each `lastBoot ∈ {clean,crash,unknown}` × `source ∈ {startup,compact,resume}`, assert the boolean. New rows that MUST hold: `(startup, crash, fresh, non-empty) => true`; `(startup, clean|unknown) => false`; compact|resume unaffected by `lastBoot`.
- Route-level test (mirror `kanban-put-unknown-field.test.ts` HTTP-mock style): a crash marker present → `/replay` returns injection; clean/absent-after-consume → null; and the marker is CONSUMED after one `/replay` (second call reads absent).
- Regression: existing taskstate replay tests still green (update call sites to pass `lastBoot`).

## Constraints
- **Fail-open + atomic** everywhere (inherited from S1; `classifyAndConsume` already best-effort).
- **Safe direction:** `unknown` → NO replay. Never resume on anything but a confirmed `crash`.
- Pure-fn stays pure (no IO in `shouldReplayTaskState`). All IO in the route.
- TDD → worktree+branch (`eng/mem-s1-s2-...` off origin/develop) → PR → Thor+Dave gate → c12 sandbox before any live agent. NOT shared develop directly.
- Run `change-impact-log.py` at PR (top-risk = false-resume on normal restart; mitigated by crash-gate + consume + TTL).

## Blast radius
One pure-fn signature change + 2 callers (route + tests). Fleet-wide (every agent's SessionStart), so c12 sandbox is mandatory. Reversible: drop the `lastBoot` arg / revert the route to the 3-arg call.
