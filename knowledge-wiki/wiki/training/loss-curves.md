---
title: "Loss Curves and Power Laws"
keywords: "loss, power-law, learning-rate, warmup, plateau"
related:
  - "wiki/scaling-laws/compute-optimal.md"
  - "wiki/training/curriculum-learning.md"
created_at: 2026-06-16
updated_at: 2026-06-16
---

## Power-law decay

Training loss falls as an approximate power law in compute, data, and model
size. Smooth curves on a log-log plot are the expected signature; sharp kinks
usually mean an optimization or data problem, not a capability jump.

## Reading a curve

- **Warmup** -- early ramp of the learning rate; instability here is a tuning
  signal.
- **Steady decline** -- the power-law regime; extrapolation guides budgeting.
- **Plateau** -- data exhaustion, LR too low, or capacity saturation.

## See also

- [Compute-Optimal Scaling](../scaling-laws/compute-optimal.md)
- [Curriculum Learning](curriculum-learning.md)
