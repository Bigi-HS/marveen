---
title: "Compute-Optimal Scaling (Chinchilla)"
keywords: "scaling, compute-optimal, chinchilla, training-flops, model-size"
sources:
  - "sources/dominik-research-notes/2026-06-05-scaling-laws-analysis.md"
related:
  - "wiki/scaling-laws/token-scaling.md"
  - "wiki/foundations/transformer-architecture.md"
created_at: 2026-06-16
updated_at: 2026-06-16
---

## Overview

For a fixed compute budget (FLOPs) there is an optimal split between model size
N and training tokens T.

## Chinchilla result (2022)

The compute-optimal frontier scales N and T roughly in proportion -- earlier
large models were under-trained on too few tokens. A smaller model trained on
more data can beat a larger, under-trained one at equal FLOPs.

## Practical implication

At a fixed budget, prefer more tokens over raw parameter count until the
optimal ratio is reached. Inference cost (which scales with N) further favors
smaller, longer-trained models.

## See also

- [Token Scaling](token-scaling.md)
- [Transformer Architecture](../foundations/transformer-architecture.md)
