---
title: "Curriculum and Data Ordering"
keywords: "curriculum, data-ordering, difficulty, staged-training"
related:
  - "wiki/training/loss-curves.md"
created_at: 2026-06-16
updated_at: 2026-06-16
---

## Idea

Order or stage training data by difficulty or domain so the model learns easy
structure before hard structure. Effects on LLM pretraining are mixed; staged
data mixtures (e.g. raising code/math weight late) are the more reliable lever.

## Practical forms

- **Length curricula** -- shorter contexts first, longer later.
- **Domain phasing** -- shift the mixture across training phases.
- **Quality annealing** -- highest-quality data near the end of training.

## See also

- [Loss Curves](loss-curves.md)
