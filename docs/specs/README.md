# Specs

Quill-authored acceptance criteria and specs for the Genesis fleet.

## Writing a new spec

Copy `template.md` as a starting point.

Key sections:
- **Execution Context** -- explicit `@file` references to the minimum set of files the implementer needs. Never "load the codebase". For Ollama agents (32K context): 5 files max.
- **Acceptance Criteria** -- atomic, decidable, implementation-independent conditions.
- **Success Criteria** -- per-task observable end-state ("task is done when..."). Different from ACs: ACs are conditions; success criteria are the complete picture of done.

## Pipeline

Quill writes spec → Thor audits independently → Dave implements → Thor+Dave gate → Armorer deploys.

Quill does not audit its own specs. That is Thor's role.

## Status values

- `DRAFT` -- in progress, not ready for audit
- `PENDING AUDIT` -- handed to Thor
- `FINAL` -- Thor green, ready for implementation
