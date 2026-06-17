---
title: "Quantization for Inference"
keywords: "quantization, int8, int4, gptq, awq, throughput"
related:
  - "wiki/inference/kv-cache.md"
created_at: 2026-06-16
updated_at: 2026-06-16
---

## Idea

Store and compute weights (and sometimes activations / KV-cache) in lower
precision -- int8, int4 -- to cut memory and bandwidth, the inference
bottleneck. Accuracy loss is small when scales are chosen well.

## Common methods

- **Post-training quantization (GPTQ, AWQ)** -- calibrate scales on a small
  dataset, no retraining.
- **Weight-only vs weight+activation** -- weight-only is simpler and usually
  enough for memory-bound decoding.
- **KV-cache quantization** -- shrinks the dominant memory term at long context.

## See also

- [KV-Cache Optimization](kv-cache.md)
