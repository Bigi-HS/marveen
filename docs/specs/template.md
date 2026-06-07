# Spec: [Title]

**Status**: DRAFT | PENDING AUDIT | FINAL  
**Author**: Quill  
**Date**: YYYY-MM-DD  
**Kanban**: [card-id]

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

1. [Question -- owner: Dominik / Dave / Thor]
