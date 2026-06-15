# Design: Per-routine context-narrowing (scheduled-task token-opt)

Card: `85d03c6b` — Per-routine context-narrowing (scheduled-task token-opt)
Effort: S–M. Status: design + implementation plan only (no production code in this doc).
Author: ephemeral eng sub-agent. Base: `develop` @ `b4f4b67`.

---

## Problem

The fleet token-burn analysis (memory `token-burn-anatomy`, 2026-06-07) names two sinks:

1. **Dominant (~70% of raw):** `cache_read` from long-lived high-context sessions re-reading
   their whole accumulated context every turn.
2. **Secondary:** "~50+ short autonomous fires (heartbeat / scheduled-task / watchdog-respawn).
   Each pays a fixed ~30–50K cache-write just to prime context (CLAUDE.md + memory) then does
   ~2 turns of near-no-op. Small each, millions summed."

This card targets sink #2: **every scheduled-task / heartbeat fire pays a fixed context-priming
cost**. The card asks us to investigate how scheduled tasks currently load context, and to
propose scoping context per task (minimal CLAUDE.md / skill load for the concrete task) instead
of paying full-context every fire.

A critical clarification this design establishes up front, because it changes the whole solution
space: **on the live fleet, a scheduled task does NOT spawn a fresh process and does NOT re-read
CLAUDE.md per fire.** It injects a prompt into a *persistent, long-lived* Claude Code tmux
session that already has CLAUDE.md + the SessionStart memory block loaded once at boot. So the
per-fire cost is not a fresh `cache-write` prime — it is **`cache_read` billed against the
whole accumulated session context, every fire**. That makes sink #2 a special case of sink #1:
the priming is paid once, then re-read on every turn for the life of the session. The lever the
card describes ("minimal context per fire") is real, but the mechanism to achieve it is
different from what the card's framing implies. See Options.

---

## Current state (grounded in source)

### How a scheduled task fires

`src/web/schedule-runner.ts` runs `startScheduleRunner()` on a 60s `setInterval`
(`schedule-runner.ts:300`, `:426`). On each tick `runCheck()`:

- lists tasks via `listScheduledTasks()` (`schedule-runner.ts:307`),
- for each enabled task whose cron matches (`cronMatchesNow`, `schedule-runner.ts:381`),
- resolves the target agent(s) and calls `attemptFireTask(task, agentName, now)`
  (`schedule-runner.ts:402`).

`attemptFireTask` (`schedule-runner.ts:98`) derives the target tmux session:

```
const session = task.targetSession
  ? task.targetSession
  : isMainAgent ? MAIN_CHANNELS_SESSION : agentSessionName(agentName)   // schedule-runner.ts:102-104
```

So the fire targets an **already-running** session (`agent-<name>`, or the main agent's
`<id>-channels`). If that session is not alive, the task is skipped/queued, never launched
(`schedule-runner.ts:112-115`). The runner never starts a process; it only writes into an
existing one.

It then builds the prompt (`schedule-runner.ts:131-164`):

- a `type`-dependent prefix (heartbeat keep-alive scaffolding `schedule-runner.ts:148-152`, or
  the `[Utemezett feladat: …]` task prefix `schedule-runner.ts:154`),
- the security preamble + the wrapped, user-editable task body
  (`UNTRUSTED_PREAMBLE` + `wrapUntrusted(...)`, `schedule-runner.ts:160-163`),

and delivers it with `sendPromptToSession(session, fullPrompt)` (`schedule-runner.ts:164`).

### What `sendPromptToSession` actually does

`sendPromptToSession` (`src/web/agent-process.ts:733`) types the prompt into the live tmux
pane via `tmux send-keys -l` in 80-char chunks and presses Enter
(`agent-process.ts:761-773`). **It does not start a session, set a model, load CLAUDE.md, or
run any SessionStart hook.** It is pure keystroke injection into a TUI that is already booted.

### When context is actually loaded (the real priming)

CLAUDE.md + memory are loaded **once per session lifetime, at boot**, not per fire:

- The session is launched by `startAgentProcess` (`agent-process.ts:178`), which builds a
  `claude … --model '<model>' …` command (`agent-process.ts:353-354`) and spawns it under
  tmux. Claude Code itself reads `CLAUDE.md` from the cwd at startup.
- The SessionStart hook chain is wired in `templates/settings.json.template:19-40`:
  on `startup` it runs `scripts/hooks/memory-replay.py`
  (`templates/settings.json.template:33-36`); on `compact|resume` it runs
  `taskstate-replay.py` (`templates/settings.json.template:24-27`).
- `memory-replay.py` injects the agent's top warm + shared memories as SessionStart
  `additionalContext`, bounded by `memory_rank.format_block`'s `CHAR_BUDGET = 1500 * 4`
  (~1500 tokens) (`scripts/hooks/memory_rank.py:19-20`).

So the boot prime is roughly: **CLAUDE.md (live `/home/domin/marveen/CLAUDE.md` = 7,471 bytes,
~1.9K tokens) + the ~1.5K-token memory block + HEARTBEAT.md when read on the keep-alive path
(`HEARTBEAT.md` = 479 bytes) + the harness/system/tools scaffold.** That is the *floor*. After
boot, context only grows: every scheduled fire, every inter-agent message, every heartbeat
turn appends to it, and **every subsequent fire re-reads the whole accumulated context as
`cache_read`.**

### Where the per-fire cost really comes from

Two distinct things, often conflated:

- **Boot prime (one-time per session):** CLAUDE.md + memory block + harness scaffold, paid
  once as `cache-write` when the session starts. The `~30–50K cache-write` figure in
  `token-burn-anatomy` corresponds to short-lived fires that *did* boot their own session
  (e.g. watchdog `--continue` respawns, or any task run in a fresh process). For a steadily
  running fleet agent, this is amortised across the whole session.
- **Per-fire re-read (every fire):** `cache_read` over the full accumulated session context.
  This is the cost that scales with `fires × context_size` and is the secondary sink in
  practice. The 15-minute memoria-heartbeat (`scheduled-tasks/memoria-heartbeat/task-config.json`:
  `"schedule": "*/15 * * * *"`) fires ~96×/day; the daily reggeli-napindito fires once.

### Existing related lever (already present, not wired to schedules)

`startAgentProcess(name, { fresh })` (`agent-process.ts:178`, `:368`) and `restartAgentProcess`
(`agent-process.ts:464`) already support a **`fresh`** mode that forces a brand-new conversation
(drops accumulated context). It is used by auto-restart, NOT by the scheduler — `schedule-runner.ts`
never calls into the process layer at all. There is also a `targetSession` override on
`ScheduledTask` (`scheduled-tasks-io.ts:42`) explicitly documented as "Enables dedicated
scheduler-only sessions in the future" — a hook the original author left for exactly this kind
of work.

---

## Goal / non-goals

**Goal:** reduce the token cost of frequent autonomous fires by ensuring each fire runs against
the *minimal* context it actually needs, without losing the context a task genuinely requires.

**Non-goals:**
- Not touching sink #1 directly (long work-session compaction is a separate card class:
  `8a734a43` non-idle HARD-ceiling compaction, etc.).
- Not changing what CLAUDE.md *says* (persona/policy). We change *how much* of it a given fire
  is forced to carry, not the content.
- No change to the merge-gate, delivery-sentinel, or skipIfBusy retry semantics.

---

## Options

### Option A — Dedicated low-context "routine" session per recurring task (recommended core)

Use the existing `targetSession` field (`scheduled-tasks-io.ts:42`) and `fresh`-launch
(`agent-process.ts:368`) to run high-frequency, low-coupling routines in a **separate,
deliberately minimal tmux session** instead of the agent's main high-context session.

Mechanism:
- A routine session is launched with a **task-scoped cwd** (so Claude Code reads a *small*
  routine-specific `CLAUDE.md`, not the full persona one) and **without the SessionStart memory
  auto-inject** (or with a tighter budget).
- The scheduler targets it via `task.targetSession`. The runner already honours this with zero
  new branching (`schedule-runner.ts:102-104`).
- The routine session is **periodically recycled** (fresh boot) so its accumulated context can
  never balloon — capping the `cache_read` growth that is the actual secondary sink.

Pros:
- Directly attacks the real cost (per-fire `cache_read` over accumulated context) by bounding
  context size, not just the one-time prime.
- Reuses two facilities that already exist (`targetSession`, `fresh`) — small surface.
- Isolates noisy heartbeats from the agent's working session, which *also* helps sink #1
  (the agent's main session stops accumulating heartbeat turns).

Cons / risks:
- A heartbeat whose whole point is "notice something important in MY current working context"
  loses that context if it runs in an isolated session. Mitigation: keep *context-dependent*
  heartbeats (e.g. "kanban-hajtás" review that needs the agent's live state) on the main
  session; only migrate *self-contained* routines (memory hygiene scan, briefing fetch,
  hygiene cron) where the task body fully specifies the work.
- More tmux sessions to supervise (watchdog/health surface grows). Mitigation: opt-in per task
  via a new `contextScope` field; default behaviour unchanged.

### Option B — Per-task minimal CLAUDE.md / skill scoping via cwd or a context manifest

Add a `contextProfile` to a task that names exactly which CLAUDE.md fragment + which skills the
fire needs. Implemented by launching/targeting a session whose cwd contains a trimmed
`CLAUDE.md` and a settings file that disables the memory auto-inject hook for routine sessions.

This is essentially the *content* half of Option A. On its own (without a separate session) it
cannot help, because CLAUDE.md is read at session boot, not per fire — you cannot "scope down"
the CLAUDE.md of an already-running persistent session for one prompt. So **Option B only has
teeth when combined with Option A** (a session whose cwd has the trimmed manifest).

Pros: precise control over what each routine carries.
Cons: maintenance burden (a manifest per routine type); easy to under-scope and break a task.

### Option C — Reduce frequency / batch fires (cadence trim)

`token-burn-anatomy` explicitly lists "trim or slow the heartbeat per-fire priming cost" as a
lever. The cheapest possible change: lengthen the cron cadence of the highest-frequency routines
and/or have them no-op faster.

- memoria-heartbeat is `*/15` (`scheduled-tasks/memoria-heartbeat/task-config.json`) → ~96
  fires/day. Halving to `*/30` halves its per-fire `cache_read` contribution with zero code.

Pros: zero engineering, immediate, reversible (config-only).
Cons: not "context-narrowing" per the card; reduces responsiveness; doesn't address per-fire
context *size*, only fire *count*. Best treated as a complementary quick win, not the answer.

### Option D — In-session `/clear` before/after a routine fire (rejected)

Prepend a `/clear` so the routine runs against an empty context. Rejected: `/clear` wipes the
agent's *working* context that other inter-agent traffic and the operator depend on; it would
turn a token optimisation into a context-loss bug. The isolated-session approach (A) gets the
same "empty context" benefit without collateral damage.

---

## Recommendation

**Adopt Option A as the core, layered with B for the content trim and C as a free quick win.**

Concretely, a phased build:

1. **Phase 0 (config-only quick win, no code):** audit cron cadences and lengthen the
   highest-frequency, low-value routines (e.g. memoria-heartbeat `*/15` → `*/30` if Boss
   agrees). Reversible, immediate. (Option C.)

2. **Phase 1 (scheduler context-scope plumbing):** add an optional `contextScope?: 'main' |
   'routine'` field to `ScheduledTask` (`scheduled-tasks-io.ts:16-43`), defaulting to `'main'`
   (current behaviour, zero change for existing tasks). When `'routine'`, the runner targets a
   shared dedicated low-context session (`targetSession` derivation) and, if that session is
   absent or stale, launches it `fresh` with a routine cwd. (Options A + B.)

3. **Phase 2 (routine-session lifecycle):** a small recycler that periodically `fresh`-reboots
   the routine session so its context cannot grow unbounded (caps the `cache_read` sink). Reuse
   `restartAgentProcess(name, { fresh: true })` (`agent-process.ts:464`).

This sequencing lets Phase 0 bank savings while Phase 1/2 are reviewed, and keeps every step
independently revertible behind a default-off flag.

### Exact files / functions that would change

| File | Change |
|---|---|
| `src/web/scheduled-tasks-io.ts` | Add `contextScope?: 'main' \| 'routine'` to the `ScheduledTask` interface (`:16-43`); parse it in `readScheduledTask` (`:77-89`); persist it in `writeScheduledTask` (`:105-135`). |
| `src/web/schedule-runner.ts` | In `attemptFireTask` (`:98-104`), when `task.contextScope === 'routine'` resolve the dedicated routine session name and, if not alive, launch it `fresh` (call into `startAgentProcess({fresh:true})`) before injecting. Keep `'main'` path byte-identical. |
| `src/web/agent-process.ts` | (Phase 2) expose a `ensureRoutineSession(cwd)` helper reusing `startAgentProcess`/`restartAgentProcess` `fresh` mode (`:368`, `:464`); no change to the steady-state launch path. |
| `templates/settings.json.template` | A routine-session settings variant that omits the `startup` `memory-replay.py` hook (`:30-39`) so routine boots skip the ~1.5K-token memory inject. |
| A new routine cwd, e.g. `agents/routine/` or `scheduled-tasks/_routine-ctx/CLAUDE.md` | A *minimal* CLAUDE.md (persona-light, just "you run self-contained routines, report results to marveen via inter-agent") so the routine session's boot prime is a fraction of the 7,471-byte main CLAUDE.md. |
| `src/web/routes/schedules.ts` | Surface `contextScope` in the create/update API + validation. |
| Dashboard schedules UI | A `contextScope` selector (out of scope for the code estimate; can ship API-only first). |

No change to `sendPromptToSession`, the busy/retry/alert paths (`schedule-runner.ts:202-298`,
`:319-377`), `cronMatchesNow`, or the merge-gate.

### Estimated token savings (order-of-magnitude, to be measured)

Grounded in the real numbers above; treat as a hypothesis the c12/test plan must confirm:

- Main-session boot prime today ≈ CLAUDE.md ~1.9K tok + memory block ~1.5K tok + harness
  scaffold + whatever the session has accumulated. A routine session with a persona-light
  CLAUDE.md (target <500 bytes, ~125 tok) and no memory inject prunes the *boot* prime by
  roughly **~3K+ tokens** and, critically, removes the routine's turns from the main session's
  ever-growing context.
- The larger win is the **`cache_read` cap**: a recycled routine session holds context to,
  say, <10K tokens vs a main session that the same memory note shows reaching **148M / 136M
  cumulative `cache_read`** on the top sessions. For a `*/15` routine (~96 fires/day), keeping
  each fire's re-read context an order of magnitude smaller is where the millions-summed
  savings come from.
- Phase 0 cadence trim alone (e.g. `*/15`→`*/30` on one routine) is a straight ~50% cut of
  that routine's fire count.

The honest position: **we cannot give a hard %% before measurement.** The build must instrument
before/after `usage` aggregation (the `token-burn-anatomy` method: aggregate `usage` per
`*.jsonl`) on a sandbox to quantify the real delta, since `cache_read` depends on live context
size which this design cannot observe statically.

---

## Risks / open questions

1. **A routine fire missing context it needed (the headline risk).** A task migrated to
   `'routine'` scope that secretly relied on the persona CLAUDE.md, the memory block, or the
   agent's live working state will silently misbehave (wrong tone, missing policy, no awareness
   of in-flight work). Mitigation: migrate ONLY self-contained tasks whose SKILL.md body fully
   specifies the work; keep the kanban-hajtás / context-aware heartbeats on `'main'`. Make
   `contextScope` opt-in and default `'main'`.
2. **Reporting path.** Routine sessions report to the operator/marveen via inter-agent; the
   routine CLAUDE.md must encode that (it can't assume the persona file's Telegram rules). The
   heartbeat keep-alive prefix (`schedule-runner.ts:148-152`) and the channel-less rules must
   stay coherent for a routine session.
3. **Extra session = extra supervision surface.** New tmux session needs watchdog / health
   coverage or it dies silently and routines stop. Tie its lifecycle to the recycler (Phase 2)
   and add it to the health monitor.
4. **Memory auto-inject is per-`startup` only** (`memory-replay.py` `INJECT_SOURCES={"startup"}`;
   `templates/settings.json.template:30-36`). Recycling the routine session re-pays the (small)
   boot prime each recycle; the recycle interval is a tunable tradeoff (fewer recycles = larger
   `cache_read` per fire; more recycles = more boot primes). Open question: optimal interval —
   determine empirically in the c12 plan.
5. **`fresh` semantics interaction.** `shouldContinueSession` (`agent-process.ts:77`) and the
   `opts.fresh` override (`agent-process.ts:368`) must be exercised so a routine session never
   accidentally `--continue`s a stale routine transcript. Covered by existing unit tests around
   those pure functions — extend them.
6. **Does the secondary sink justify the complexity?** If post-deploy measurement shows sink #2
   is dominated by watchdog respawns (fresh boots) rather than scheduled fires into live
   sessions, then Phase 0 + better respawn hygiene may capture most of the win and Phase 1/2
   could be deferred. The c12 measurement gates whether Phase 1/2 ships.

---

## Acceptance criteria (for the eventual build)

- **AC1:** `ScheduledTask` gains `contextScope?: 'main' | 'routine'`, defaulting to `'main'`;
  every existing task (no field) behaves byte-for-byte as today (no diff in delivered prompt,
  no new session, no behaviour change). Proven by a runner unit test on an existing task.
- **AC2:** A task with `contextScope: 'routine'` fires into the dedicated routine session; if
  that session is absent it is launched `fresh` with the routine cwd before injection; the
  `'main'` path is untouched.
- **AC3:** The routine session boots WITHOUT the `startup` memory auto-inject and reads the
  persona-light routine CLAUDE.md, not the 7,471-byte main one. Verified by capturing the
  routine session's SessionStart context.
- **AC4:** Measured token delta: a sandbox before/after run (same routine, `'main'` vs
  `'routine'`) shows a strictly lower per-fire `cache_read`, aggregated with the
  `token-burn-anatomy` `usage`-per-`*.jsonl` method. Target: ≥30% per-fire reduction for a
  migrated self-contained routine (refine target after the first measurement).
- **AC5:** No regression in busy/retry/alert paths: skipIfBusy bounded retry, pending-retry
  alert, and the catch-up window still pass their existing tests
  (`src/__tests__/schedule-runner-skipIfBusy-requeue.test.ts`,
  `schedule-runner-heartbeat-prefix.test.ts`).
- **AC6:** A migrated routine still completes its actual job (e.g. memory hygiene scan still
  writes its findings) — proven on the c12 sandbox, not just unit-mocked.
- **AC7:** `npm run typecheck` and `npm test` green; merge-gate = Thor + Dave (no
  credential/auth surface, so Chad not required).

## c12 / test plan

- **Unit (no tmux):** extend the schedule-runner tests to cover the new `contextScope` branch in
  `attemptFireTask` — assert `'main'` produces the identical session/prompt as today and
  `'routine'` resolves the routine session. Add `scheduled-tasks-io` parse/persist round-trip
  tests for the new field.
- **Pure-function tests:** extend `decideLaunchRetry` / `shouldContinueSession` coverage for the
  routine `fresh` path so a routine reboot never `--continue`s.
- **c12 chameleon sandbox (mandatory — this touches launch/session lifecycle):** per the
  `c12-chameleon-test` skill and fleet-eng-context rule "never test lifecycle/launch on a live
  agent", run the whole flow on Buster:
  1. Configure a self-contained routine task (`contextScope: 'routine'`) targeting Buster.
  2. Fire it, confirm the routine session boots with the trimmed CLAUDE.md and no memory inject
     (capture-pane + transcript inspection).
  3. Run the same routine in `'main'` scope for a baseline.
  4. Aggregate `usage` from both runs' `*.jsonl` and report the `cache_read` delta (AC4).
  5. Confirm the routine actually did its job (AC6) and the routine session recycles without
     wedging.
- **Regression:** full `npm test` + `npm run typecheck`; attach the `pre-gate-evidence-bundle`
  output to the gate request.

---

## Appendix: claims map (file:line evidence)

- Runner is a 60s interval injecting into existing sessions: `src/web/schedule-runner.ts:300`,
  `:426`, `:98-104`, `:402`.
- Fire targets an already-running session, never launches: `schedule-runner.ts:112-115`.
- Prompt build + delivery: `schedule-runner.ts:131-164`.
- `sendPromptToSession` is pure keystroke injection (no context load):
  `src/web/agent-process.ts:733`, `:761-773`.
- Session boot is where the model + CLAUDE.md load: `agent-process.ts:178`, `:353-354`.
- SessionStart memory auto-inject hook + budget: `templates/settings.json.template:19-40`,
  `scripts/hooks/memory-replay.py` (`INJECT_SOURCES={"startup"}`),
  `scripts/hooks/memory_rank.py:19-20` (`CHAR_BUDGET = 1500 * 4`).
- `fresh` launch mode already exists, not used by scheduler: `agent-process.ts:368`, `:464`.
- `targetSession` reserved "for dedicated scheduler-only sessions in the future":
  `src/web/scheduled-tasks-io.ts:40-42`.
- Live CLAUDE.md size 7,471 bytes; HEARTBEAT.md 479 bytes (measured on the host).
- Token-burn anatomy figures (sink #2 = fixed per-fire prime; 148M/136M top-session
  `cache_read`): memory `token-burn-anatomy`.
