---
title: "Attention Mechanism"
keywords: "attention, self-attention, query-key-value, softmax, context"
sources:
  - "sources/big-ben-archival/2026-04-karpathy-lecture-notes.md"
related:
  - "wiki/foundations/transformer-architecture.md"
  - "wiki/inference/kv-cache.md"
created_at: 2026-06-16
updated_at: 2026-06-16
---

## Idea

Attention lets each token build its representation from a weighted sum over all
tokens, where the weights are learned from content similarity rather than fixed
position.

## Scaled dot-product attention

For queries Q, keys K, values V:

```
attn(Q, K, V) = softmax(Q K^T / sqrt(d_k)) V
```

The `1/sqrt(d_k)` scale keeps the dot products in a range where softmax has
usable gradients.

## Multi-head

Project Q/K/V into h subspaces, attend independently, concatenate. Different
heads specialize (syntax, coreference, positional patterns).

## See also

- [Transformer Architecture](transformer-architecture.md)
- [KV-Cache Optimization](../inference/kv-cache.md)
