---
title: "Token Scaling and Data Quality"
keywords: "tokens, data-scaling, data-quality, deduplication, epochs"
related:
  - "wiki/scaling-laws/compute-optimal.md"
  - "wiki/training/loss-curves.md"
created_at: 2026-06-16
updated_at: 2026-06-16
---

## Data is half the law

Compute-optimal scaling assumes enough unique high-quality tokens. When data is
the bottleneck, options are: more sources, smarter filtering, or limited
repetition (epochs) with diminishing returns.

## Quality levers

- **Deduplication** -- near-duplicate removal improves loss per token.
- **Filtering** -- quality classifiers and heuristics raise signal density.
- **Mixture** -- domain weighting (code, web, books) shapes capabilities.

## See also

- [Compute-Optimal Scaling](compute-optimal.md)
- [Loss Curves](../training/loss-curves.md)
