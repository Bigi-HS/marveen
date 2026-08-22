# Spec: [Title]

**Status**: DRAFT | PENDING AUDIT | FINAL  
**Author**: Quill  
**Date**: YYYY-MM-DD  
**Kanban**: [card-id]

---

## Forcing Questions

> Answer all five before writing a single line of spec. If you cannot answer Q3 or Q4, stop and ask.
> These are not filler -- they determine whether the spec should exist at all.

**Q1 -- What problem does this solve?**  
[Concrete problem statement. Not "we need X" but "Y currently breaks / is missing / causes Z."]

**Q2 -- Who uses this, and how often?**  
[Role + frequency. "Dominik, daily" vs "Thor, once per PR" changes scope significantly.]

**Q3 -- What is the simplest version that works?**  
[If the answer is "a one-liner script" or "an existing tool with config", say so. Don't build what can be configured.]

**Q4 -- What happens if we don't build this?**  
[Acceptable workaround? Manual step? Actual breakage? If "nothing breaks", reconsider priority.]

**Q5 -- What are we explicitly NOT building?**  
[Scope boundary. List what's tempting but out of scope. This prevents scope creep before it starts.]

---

## Spec Phases

> Track which phase this spec is in. Move forward only when the current phase is resolved.

- [ ] **Clarify** -- Forcing questions answered; ambiguities surfaced and resolved
- [ ] **Decompose** -- Work broken into independently deliverable pieces (if applicable)
- [ ] **Specify** -- ACs written, edge cases listed, execution context populated
- [ ] **Validate** -- Thor audit green; open questions resolved
- [ ] **Finalize** -- FINAL status set; handed to implementer

---

## Scope

In scope: [what this spec covers]  
Out of scope: [what is explicitly excluded -- boundary is as important as scope]

---

## User Story

As [role], I want [capability], so that [value/outcome].

---

## Execution Context

> Files the implementer must load. List the minimum required set -- not "load the codebase".
> Use @file syntax so the agent can inject them directly. Remove this block if inapplicable.

Relevant files:
- `@./path/to/main-module.ts` -- [why it's needed]
- `@./path/to/config.json` -- [why it's needed]
- `@./path/to/related-spec.md` -- [why it's needed]

Key symbols / entry points:
- `FunctionName` in `path/to/file.ts:NN` -- [brief context]

> For Ollama agents (32K context): keep this list to 5 files maximum.

---

## Acceptance Criteria

**AC1 -- [Name]**  
[Description. One criterion, one thing.]  
*Measurable: [how to verify this is met -- observable, pass/fail]*

**AC2 -- [Name]**  
[Description.]  
*Measurable: [verification]*

<!-- Add ACs as needed. Each AC must be: atomic, decidable (yes/no), testable, implementation-independent. -->

---

## Edge Cases

| Case | Expected behavior |
|---|---|
| [input condition] | [observable outcome] |
| [error/boundary condition] | [observable outcome] |

---

## Success Criteria

> Per-task definition of done. Distinct from ACs: ACs define individual conditions; success criteria define the complete observable end-state that means this task is finished.

This task is complete when:

1. [Concrete, observable end-state -- e.g. "GET /api/agents returns category field for all agents"]
2. [Another end-state -- e.g. "Browser shows tree view by default on /agents"]
3. [Test / verification step -- e.g. "No regression in existing flat list view (manual smoke test)"]
4. [Documentation / artifact -- e.g. "seed-config/agent-categories.json exists and is committed"]

Not complete until: [anything that would make the task incomplete despite ACs passing -- e.g. "Dominik GO received", "Thor gate green"]

---

## Open Questions

> Block on these before handing to implementer. If none: write "None."
>
> **GATE-BLOCKED pattern**: If an open decision structurally prevents a testable AC (e.g. the answer changes the data model, a delete mechanic, or a boundary constant), mark the spec status GATE-BLOCKED and add a visible header at the top. Dave cannot build; Thor cannot audit. One-word answers unblock instantly.

1. [Question -- owner: Dominik / Dave / Thor]

---

## Closing Block

> Required before marking status FINAL. Key Decisions must have >=1 row. Red-team pre-mortem is mandatory per fleet policy 06-11 (decision-owner runs it; attaches top risks + mitigations before FINAL).

### Key Decisions

| Decision | Chosen | Alternatives considered | Why |
|---|---|---|---|
| [decision point] | [chosen option] | [other options considered] | [rationale -- include "boss decision YYYY-MM-DD" if applicable] |

### Red-team pre-mortem ([author], YYYY-MM-DD)

**Core claim**: This spec succeeds iff [single sentence -- what must be true for it to work].

**Top risks identified:**
1. **[Name] (HIGH/MEDIUM/LOW)**: [what breaks and why] -- Mitigation: [what was done in the spec]
2. **[Name] (HIGH/MEDIUM/LOW)**: [what breaks and why] -- Mitigation: [what was done in the spec]

**Unverified assumptions (residual)**: [anything not mitigated and why it is accepted]

**Verdict**: PROCEED / PROCEED-WITH-MITIGATIONS / RECONSIDER

> Common pitfalls to check: scheduled-task mechanisms (cron expr, not delay-seconds); 24h auto-close needs hourly heartbeat not a single 86400s timer; DST-sensitive time boundaries need wall-clock tz-aware logic not fixed UTC offsets; hard-delete UX needs confirmation step.

### Retrospective (fill at FINAL handoff)

1. Were all ACs atomic? [yes / no -- if no, what was split post-audit]
2. Did edge cases surface late? [yes / no -- if yes, which]
3. Were open questions genuine blockers? [yes / no]
4. How many Thor audit rounds, and why? [N rounds -- root cause]
5. Template improvement from this spec? [specific change or "none"]
