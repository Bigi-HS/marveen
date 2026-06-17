---
title: "Transformer Architecture"
keywords: "transformer, encoder-decoder, self-attention, parallelization"
sources:
  - "sources/dominik-research-notes/2026-06-01-transformer-internals.md"
  - "sources/big-ben-archival/2026-04-karpathy-lecture-notes.md"
related:
  - "wiki/foundations/attention-mechanism.md"
  - "wiki/scaling-laws/compute-optimal.md"
  - "wiki/inference/kv-cache.md"
created_at: 2026-06-16
updated_at: 2026-06-16
---

## Overview

The Transformer (Vaswani et al., 2017) replaced recurrence with full attention,
unlocking parallel computation across sequence positions and removing the
sequential bottleneck that limited RNN training throughput.

## Core components

- **Encoder-decoder stack** -- encoder builds contextual representations; the
  decoder generates output autoregressively.
- **Multi-head self-attention** -- several heads attend to different
  representation subspaces in parallel.
- **Position-wise feed-forward networks** -- a 2-layer MLP applied per token.
- **Residual connections + LayerNorm** -- keep gradients stable at depth.

## Computational profile

A serial RNN takes O(T) sequential steps; the Transformer takes O(1) sequential
steps but O(T^2) attention work per layer. For long sequences (T in the
thousands) the parallelism wins decisively.

## See also

- [Attention Mechanism](attention-mechanism.md)
- [Compute-Optimal Scaling](../scaling-laws/compute-optimal.md)
- [KV-Cache Optimization](../inference/kv-cache.md)
