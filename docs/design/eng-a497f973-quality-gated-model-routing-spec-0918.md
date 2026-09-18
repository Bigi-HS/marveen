# ENG-a497f973 — Quality-gated model-routing layer (HydraFusion-analog)

Author: Dave · Date: 2026-09-18 · Status: SPEC / SPIKE (no impl yet) → Thor+Dave gate
Refs: card ENG-a497f973, memory `github-copilot-2026-fleet-convergence`, skills `opus-escalation`, `llm-cost-optimizer`

## 1. Problem framing (grounded, corrected)

Copilot's Project HydraFusion does per-task model routing (draft → critique → escalate) and
advertises "36-67% cheaper than Opus baseline". That framing is **API-dollar** and does **not**
apply to us: the fleet runs on a **claude.ai Max subscription** — the currency is **quota**, not
dollars, and the recurring pain is the **Opus weekly cap** (`llm-cost-optimizer`).

So the objective is narrow and precise:

> **Reclaim Opus weekly quota** by having tasks that *today default to Opus* first attempt a
> **Sonnet draft**, and burn Opus **only when an automatic quality-gate fails** — without
> degrading output quality.

### What we already have (most of the surface is covered)
- `opus-escalation` skill — escalate to an Opus sub-agent. **Manual, judgment-driven, agent
  decides.** Inconsistent; most agents never run the checklist in their head. ← the actual gap.
- Workflow tool — `agent(prompt, {model, schema})`: per-call model choice + **schema-validated
  output with automatic retry**; judge-panel / adversarial-verify patterns.
- Per-agent fixed model config (`agents/<id>/agent-config.json`).
- `/fleet`-equivalent (Workflow fan-out), custom agents (`agents/<id>/CLAUDE.md`+skills), MCP,
  scheduled-tasks, agentic code review (Thor+Dave gate).

**The one real gap:** an *automatic, per-task, quality-gated* draft→gate→escalate step, so the
Sonnet-first discipline is executed by code, consistently, instead of by human judgment.

## 2. Scope red-team (the important part — done BEFORE building)

Three hard questions the card asked me to answer before writing any router.

### RT-1 — Does draft→escalate actually reclaim Opus quota, or is it a net loss?
The pattern only wins when **both** hold:
1. the task **today defaults to Opus**, and
2. the **Sonnet gate-pass rate is high** (Sonnet draft is accepted most of the time).

If most drafts fail the gate, we burn `Sonnet draft + Sonnet critic + full Opus` — that is *more*
total burn, and Opus burn is **unchanged** (we still make the Opus call). So this is **not** a
blanket wrapper for all model calls. It is a targeted pattern for **Opus-default workloads with a
plausibly-high Sonnet pass-rate**. The precondition itself must be measured, not assumed.

### RT-2 — Where can an "automatic" gate actually live?
There are two worlds, and only one is automatable cheaply:

- **World A — Workflow orchestration context.** `agent()` already takes `model` + `schema`. A thin
  JS helper `routedAgent(task, gate)` that does draft-Sonnet → gate → escalate-Opus is **trivially
  buildable** and is exactly where bulk fan-out model-burn happens. ✅ Automatable.
- **World B — live tmux agent sessions** (Dave, marveen, …). Their model is **fixed at launch**;
  you cannot inject a per-task router into a running session. The only lever there is the
  `opus-escalation` discipline (spawn an Opus sub-agent via the Agent tool). Making that
  "automatic" would need a hook/CLI-wrapper interception layer — a **much larger build**, fragile,
  and not where the quota is. ❌ Out of scope for slice 1.

**The biggest single Opus lever is not per-task routing at all** — `llm-cost-optimizer` names it:
moving Opus-default *agents* (Dave opus-1M, radar) to Sonnet by config. That is a config decision,
orthogonal to this card, and cheaper than any router. Flagged so we don't over-attribute savings
to the router.

### RT-3 — Is a schema-valid gate a real quality gate?
No. **Schema-valid ≠ correct.** A Sonnet draft can be schema-valid and wrong. So the gate must be
`schema-validation AND a short critic-pass`, not schema alone. But the critic is itself a model
call whose judgment can err; if the critic is *also* Sonnet, it may rubber-stamp Sonnet's
correlated mistakes. The gate is therefore a **filter, not a guarantee** — Opus-on-fail is the
safety net, and we must **measure the gate's false-pass rate**, not assume it works.

### Red-team verdict
> **Build a thin, reusable `routedAgent()` helper for the Workflow harness. Do NOT build a
> homegrown model-router service, a live-session interceptor, or a task-classifier.** The existing
> Workflow `model`+`schema` machinery plus a ~40-line wrapper covers the real gap. Anything bigger
> fails the "does existing patterns + a thin wrapper suffice?" test in the card.

## 3. What we build (slice 1)

A single reusable helper + a critic primitive, shipped as a **skill/snippet** (a copy-paste block
for Workflow scripts) plus a small tested module. No new service, no new process.

```
// routedAgent(task, {schema, critic, opusModel='opus', draftModel='sonnet'})
//   1. draft  = agent(task, {model: draftModel, schema})        // schema auto-retries
//   2. verdict = gate(draft)                                    // schema already ok here
//        gate = schema-valid (implicit, done)  AND  critic(draft) says PASS
//   3. if verdict.pass  -> return {result: draft, escalated:false, ...telemetry}
//      else             -> return {result: agent(task,{model:opusModel,schema}), escalated:true}
//
// critic(draft): a SHORT cheap agent call (Sonnet/Haiku) with an adversarial prompt:
//   "Here is a task and a draft answer. Find a concrete, disqualifying defect. If none, PASS."
//   returns {pass: bool, reason} via a fixed schema. Bias toward FAIL on genuine uncertainty
//   (a false-fail costs Opus quota; a false-pass costs correctness — correctness wins).
```

Telemetry emitted per call (the whole point — measurement): `task-label, draft-model, escalated
(bool), critic-verdict, critic-reason`. Written to a store JSONL so escalation-rate and Opus-burn
are computable.

### Explicit non-goals (what we do NOT build)
- ❌ No homegrown router service / daemon / classifier.
- ❌ No live-session (World B) interception — `opus-escalation` stays the mechanism there. (If
  wanted later, a *separate* card; not this slice.)
- ❌ No change to per-agent model config (that Opus lever is orthogonal — separate decision).
- ❌ No ML/heuristic task-difficulty prediction. Draft-first-then-gate is the whole strategy.

## 4. Measurement plan (defines success; the reframe demands it)

Run the helper on a representative Opus-default workload (candidate: a Workflow that today runs
Opus fan-out, e.g. a review/audit pass) for a bounded pilot. Compare against an all-Opus baseline
on the **same** tasks.

| Metric | Definition | Success direction |
|---|---|---|
| **Escalation rate** | escalated / total tasks | LOW = quota reclaimed (high pass-rate). If HIGH → RT-1 fails, kill the pattern for that workload |
| **Opus burn** | Opus output tokens over the pilot vs all-Opus baseline | DOWN, materially |
| **Sonnet-bucket burn** | draft+critic Sonnet tokens added | must not become the new bottleneck |
| **Gate false-pass rate** | of drafts the gate PASSED, how many a human/Opus spot-check judges wrong | must stay LOW — this is the quality guard |
| **Quality delta** | spot-check final outputs vs all-Opus baseline | NO regression (hard gate) |

Decision rule: adopt only if `Opus burn ↓ materially` **AND** `false-pass rate low` **AND**
`no quality regression`. If escalation rate is high on every candidate workload, the honest
conclusion is "the router doesn't help us — reclaim Opus via config instead" and we say so.

## 5. Plan of record
1. **This spec → Thor+Dave gate** (scope sign-off before code). ← we are here.
2. TDD the `routedAgent` + `critic` module (unit tests: pass-path no-escalate, fail-path escalate,
   schema-retry, telemetry shape; adversarial fixtures for critic false-pass/false-fail).
3. Ship as a reusable snippet + skill; wire telemetry JSONL.
4. Bounded pilot on one Opus-default Workflow; collect the table in §4.
5. Report measured verdict to Boss via marveen. Adopt / adjust / drop per the decision rule.

No deadline; spec delivered this week per the card.
