# Ollama VRAM Cookbook

> Maintainer: Scout (model-upgrade migration owner)
> Created: 2026-06-10
> Sources: ollama.com/library (primer), Odysseus hwfit service (github.com/pewdiepie-archdaemon/odysseus), willitrunai.com, morphllm.com

Fleet reference for local LLM model selection on the Genesis host.

---

## Fleet Hardware Baseline

| Component | Value |
|-----------|-------|
| GPU | NVIDIA RTX 3060 |
| Total VRAM | 12 GB |
| VRAM free (typical) | ~7.7 GB (4.3 GB used by OS + other processes) |
| Ollama version | 0.30.6 |
| Embedding model | nomic-embed-text (274 MB, always resident) |
| Available for LLMs | ~7.4 GB (after nomic-embed headroom) |

**Currently deployed:**

| Model | VRAM | Role |
|-------|------|------|
| qwen3:4b × 2 | 5.0 GB | marveen-local + claudia-local (parallel instances) |
| nomic-embed-text | 0.27 GB | embedding pipeline |
| **Total** | **5.27 GB / 7.7 GB (68%)** | comfortable headroom |

---

## Model VRAM Table (Ollama-native, Q4_K_M default)

Download size ≈ VRAM footprint at Q4_K_M. Add ~0.5 GB runtime overhead.

### Qwen3 family (RL-trained, agentic tool-calling)

| Model | Download size | Context | Notes |
|-------|-------------|---------|-------|
| qwen3:0.6b | 523 MB | 40K | minimal, edge only |
| qwen3:1.7b | 1.4 GB | 40K | lightweight assistant |
| **qwen3:4b** | **2.5 GB** | **256K** | **fleet standard (deployed)** |
| qwen3:8b | 5.2 GB | 40K | solo only on RTX 3060 [¹] |
| qwen3:14b | 9.3 GB | 40K | exceeds 7.7 GB free -- NO |
| qwen3:30b-a3b (MoE) | 19 GB | 256K | multi-GPU only |
| qwen3:235b-a22b (MoE) | 142 GB | 256K | datacenter only |

[¹] Context asymmetry: qwen3:4b ships with 256K context in the Ollama package while qwen3:8b defaults to 40K. This is an Ollama packaging quirk, not a model capability difference -- the underlying qwen3:8b supports longer context but the default Ollama tag caps it at 40K.

Source: ollama.com/library/qwen3

### Qwen2.5 family (stable, proven tool-calling)

| Model | Download size | Context | Notes |
|-------|-------------|---------|-------|
| qwen2.5:0.5b | 398 MB | 32K | edge |
| qwen2.5:1.5b | 986 MB | 32K | |
| qwen2.5:3b | 1.9 GB | 32K | |
| qwen2.5:7b | 4.7 GB | 32K | fallback if qwen3:4b fails tool-call validation |
| qwen2.5:14b | 9.0 GB | 32K | exceeds 7.7 GB free -- NO |
| qwen2.5:32b | 20 GB | 32K | multi-GPU only |

Source: ollama.com/library/qwen2.5

### Llama 3.2 family (Meta, strong reasoning)

| Model | Download size | Context | Notes |
|-------|-------------|---------|-------|
| llama3.2:1b | 1.3 GB | 128K | edge |
| llama3.2:3b | 2.0 GB | 128K | good context/size ratio |

Source: ollama.com/library/llama3.2

### Gemma 3 family (Google, vision-capable)

| Model | Download size | Context | Notes |
|-------|-------------|---------|-------|
| gemma3:270m | 292 MB | 32K | minimal |
| gemma3:1b | 815 MB | 32K | |
| gemma3:4b | 3.3 GB | 128K | vision capable |
| gemma3:12b | 8.1 GB | 128K | exceeds 7.7 GB free -- NO |
| gemma3:4b-it-qat | ~3.3 GB | 128K | QAT, same quality as BF16 |

Source: ollama.com/library/gemma3

### Other fleet-relevant models

| Model | Download size | Context | Notes |
|-------|-------------|---------|-------|
| mistral:7b | 4.4 GB | 32K | solid general purpose, solo only |
| phi4:14b | 9.1 GB | 16K | exceeds budget -- NO |
| nomic-embed-text | 274 MB | 2K | embedding only (deployed) |

---

## RTX 3060 Fit Matrix

Quick reference: what fits in 7.7 GB free VRAM.

| Scenario | Models | Total VRAM | Fits? |
|---------|--------|------------|-------|
| Fleet standard | qwen3:4b + qwen3:4b + nomic-embed | 5.27 GB | YES |
| Solo large | qwen2.5:7b + nomic-embed | 4.97 GB | YES |
| Solo larger | qwen3:8b + nomic-embed | 5.47 GB | YES |
| Dual medium | qwen2.5:7b + qwen3:4b + nomic-embed | 7.47 GB | YES (tight) |
| Over budget | qwen2.5:14b + nomic-embed | 9.27 GB | NO |
| Over budget | qwen3:14b + anything | 9.57 GB+ | NO |

**Rule of thumb:** models ≥9 GB don't fit alongside nomic-embed on this host.

---

## VRAM Estimation Formula

Source: Odysseus `services/hwfit/models.py` (`estimate_memory_gb()`)

```
VRAM_GB = (params_B × bits_per_param / 8) + (kv_cache_overhead × context_length) + 0.5
```

Where `bits_per_param` by quantization:

| Quantization | Bits/param | Quality penalty | Speed multiplier |
|-------------|-----------|----------------|-----------------|
| Q8_0 | 8.0 | 0.0 (reference) | 0.85x |
| Q6_K | 6.0 | -0.01 | 0.90x |
| Q5_K_M | 5.0 | -0.02 | 0.95x |
| **Q4_K_M** | **4.5** | **-0.05** | **1.0x (baseline)** |
| Q3_K_M | 3.5 | -0.12 | 1.1x |
| Q2_K | 2.5 | -0.25 | 1.2x |

Pre-quantized formats: AWQ, GPTQ, mlx, FP8, FP4 (model-specific, check HF card).

**Example: qwen3:4b at Q4_K_M**
```
(4B × 4.5 bits / 8) + overhead + 0.5 = 2.25 + ~0 + 0.5 ≈ 2.75 GB
```
Matches the 2.5 GB ollama.com figure (Ollama strips some overhead, KV cache allocated at inference time).

---

## Serving Profiles (Three-Tier)

Source: Odysseus `services/hwfit/profiles.py`

| Profile | Quantization | KV cache | Context | Use case |
|---------|-------------|----------|---------|----------|
| Quality | Q6_K | q8_0 | 131K | Best answers; CPU MoE offload for large models |
| Balanced | Q4_K_M | q4_0 | 131K | Good speed/quality mix at full context |
| Speed | Q4_K_M | q4_0 | 32K | Fastest tokens/s, trimmed context |

Fleet recommendation: **Balanced** for background agents (marveen-local, claudia-local). Speed profile for heartbeat/triage tasks.

Headroom allocation (Odysseus):
- Vision models: +1.1 GB
- Text-only models: +0.4 GB

---

## Fleet Watchdog Model Guard

The local-agent watchdog MUST validate the model field before launch. See `store/ollama-hybrid-spec-delta.md` for the dual-check implementation.

```bash
# Positive allowlist (update here when adding new Ollama models to fleet)
OLLAMA_ALLOWED=("qwen3:4b" "qwen3:4b-instruct-q4_k_m" "qwen2.5:7b" "qwen3:8b")
```

Add new models to this list only after Buster validation (tool-calling test + VRAM fit test).

---

## KV Cache Notes

For long-context models, KV cache VRAM scales with context length:

- qwen3:4b at 256K context: KV cache can reach 1-3 GB at high fill
- Fleet background tasks average <10K tokens -- KV cache negligible in practice
- Adaptive restart trigger at 80% context% guards against saturation

Do not run qwen3:8b at full 40K context alongside nomic-embed without profiling first -- combined KV + weights may push past the 7.7 GB budget.
