---
title: "Code Generation"
keywords: "code-generation, fill-in-the-middle, infilling, evaluation, pass-at-k"
related:
  - "wiki/applications/reasoning.md"
  - "wiki/foundations/transformer-architecture.md"
created_at: 2026-06-16
updated_at: 2026-06-16
---

## What changes for code

Code is highly structured and executable, so generation can be checked by
running it. Training mixes left-to-right with fill-in-the-middle (infilling) so
the model can complete inside a file, not just at the end.

## Evaluation

- **pass@k** -- probability at least one of k samples passes the unit tests.
- **Execution-based** -- run candidates against tests rather than string match.

## See also

- [Reasoning](reasoning.md)
- [Transformer Architecture](../foundations/transformer-architecture.md)
