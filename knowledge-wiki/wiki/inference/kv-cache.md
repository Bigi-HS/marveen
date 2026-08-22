---
title: "KV-Cache Optimization"
keywords: "kv-cache, inference, memory, latency, autoregressive-decoding"
sources:
  - "sources/big-ben-archival/2026-05-inference-optimization-talk.md"
related:
  - "wiki/inference/quantization.md"
  - "wiki/foundations/attention-mechanism.md"
created_at: 2026-06-16
updated_at: 2026-06-16
---

## Problem

During autoregressive decoding the model emits one token at a time. Naively,
attention recomputes the keys and values for all past tokens at every step --
O(T^2) redundant work over a sequence.

## Solution

Cache the past keys/values. At step t+1 reuse K_1..t, V_1..t from the cache and
only compute the new token's K/V. This trades recomputation time for O(T)
memory per sequence.

## Memory-bound regime

At large batch and context, KV-cache size dominates and decoding becomes
memory-bandwidth limited, not compute limited. This is why quantization and
paged/streaming KV layouts matter for throughput.

## See also

- [Quantization](quantization.md)
- [Attention Mechanism](../foundations/attention-mechanism.md)
