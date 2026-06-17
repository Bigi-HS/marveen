---
title: "Reasoning and Chain-of-Thought"
keywords: "reasoning, chain-of-thought, self-consistency, inference-time-compute"
related:
  - "wiki/applications/code-generation.md"
  - "wiki/scaling-laws/compute-optimal.md"
created_at: 2026-06-16
updated_at: 2026-06-16
---

## Eliciting reasoning

Prompting the model to produce intermediate steps (chain-of-thought) improves
multi-step problems. Sampling several chains and taking a majority vote
(self-consistency) raises accuracy further at extra inference cost.

## Inference-time compute

Spending more compute at inference (more samples, longer chains, search) trades
latency for accuracy -- a complement to scaling training compute.

## See also

- [Code Generation](code-generation.md)
- [Compute-Optimal Scaling](../scaling-laws/compute-optimal.md)
