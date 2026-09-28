#!/usr/bin/env python3
"""DA Phase-2 cross-model critic via ollama (card 637543d6).

Calls qwen3:8b (or a configured fallback) on the T3 round-3 findings to surface
Claude blind spots. Graceful degradation: if ollama is unavailable or the model
is not found, returns SKIPPED without blocking the pipeline.

Usage (called by DA agent after T3 round 3 when CRITICAL/HIGH findings exist):
    python3 scripts/da-cross-model-critic.py \
        --decision-summary "Deploy new auth middleware" \
        --findings "F1: CRITICAL - token in env, F2: HIGH - race on shared lock" \
        [--model qwen3:8b] \
        [--api-base http://localhost:11434] \
        [--sentinel store/da-runs/T3-abc.json]

Prints the cross_model_critic JSON block to stdout.
Exit code is always 0 (never blocks pipeline).

DA CLAUDE.md integration (Phase 2a, wired at T3 round 3):
  After round 3 completes (or round 2 if round 3 was skipped due to convergence),
  if CRITICAL/HIGH findings exist AND T3 trigger AND should_run_cross_critic()=True:
    result = run_cross_critic(decision_summary, findings_text)
    sentinel["cross_model_critic"] = result
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Any

DEFAULT_MODEL = "qwen3:8b"
FALLBACK_MODEL = "qwen3:4b"
DEFAULT_API_BASE = "http://localhost:11434"

PROMPT_TEMPLATE = """\
You are an adversarial critic. You will be given a software design decision
and a set of red-team findings from a Claude-based reviewer. Your job:

1. Identify any findings you DISAGREE with (state why).
2. Identify risks the Claude reviewer MISSED (especially: concurrency issues,
   resource exhaustion, filesystem edge cases, trust boundary violations).
3. State your overall verdict on the FIRST LINE as exactly one of:
   AMPLIFY   (Claude's findings are solid and your analysis confirms them)
   DIVERGE   (you see it differently -- explain below)
   NOTHING NEW (you found nothing the Claude reviewer missed)

Keep it under 300 words. No praise. No hedging.

If you disagree with any finding, list them under "Divergences:".
If you found missed risks, list them under "Missed by Claude:".

--- DECISION ---
{decision_summary}

--- CLAUDE DA FINDINGS ---
{da_findings}
"""


# --------------------------------------------------------------------------- #
# Pure logic helpers
# --------------------------------------------------------------------------- #

def should_run_cross_critic(
    *,
    trigger: str,
    round_num: int,
    has_critical_or_high: bool,
    ollama_available: bool,
) -> bool:
    """Return True if the cross-model critic should fire."""
    return (
        trigger == "T3"
        and round_num == 3
        and has_critical_or_high
        and ollama_available
    )


def build_critic_prompt(decision_summary: str, da_findings: str) -> str:
    return PROMPT_TEMPLATE.format(
        decision_summary=decision_summary.strip(),
        da_findings=da_findings.strip(),
    )


def parse_critic_response(response_text: str) -> dict:
    """Extract verdict, divergences, and missed_by_claude from raw model output."""
    text = response_text.strip()
    lines = text.splitlines()

    # First non-empty line should be the verdict
    verdict = "DIVERGE"
    for line in lines:
        stripped = line.strip().upper()
        if "NOTHING NEW" in stripped or "NOTHING_NEW" in stripped:
            verdict = "NOTHING_NEW"
            break
        elif stripped.startswith("AMPLIFY"):
            verdict = "AMPLIFY"
            break
        elif stripped.startswith("DIVERGE"):
            verdict = "DIVERGE"
            break

    # Extract bullet lists under section headers
    divergences: list[str] = []
    missed_by_claude: list[str] = []

    current_section: str | None = None
    for line in lines:
        upper = line.upper()
        if "DIVERGENCE" in upper or "DISAGREE" in upper:
            current_section = "divergences"
        elif "MISSED BY CLAUDE" in upper or "MISSED BY THE CLAUDE" in upper:
            current_section = "missed"
        elif line.strip().startswith("-") or line.strip().startswith("*"):
            item = line.strip().lstrip("-*").strip()
            if item:
                if current_section == "divergences":
                    divergences.append(item)
                elif current_section == "missed":
                    missed_by_claude.append(item)

    return {
        "verdict": verdict,
        "divergences": divergences,
        "missed_by_claude": missed_by_claude,
    }


def build_critic_sentinel_field(
    *,
    model: str,
    verdict: str,
    divergences: list[str],
    missed_by_claude: list[str],
) -> dict:
    """Build the `cross_model_critic` sentinel field."""
    return {
        "model": model,
        "verdict": verdict,
        "divergences": divergences,
        "missed_by_claude": missed_by_claude,
    }


# --------------------------------------------------------------------------- #
# I/O: ollama call (graceful degradation)
# --------------------------------------------------------------------------- #

def call_ollama_critic(
    *,
    prompt: str,
    model: str = DEFAULT_MODEL,
    api_base: str = DEFAULT_API_BASE,
) -> dict:
    """Call ollama /api/generate and return parsed critic result.

    Returns SKIPPED result on any I/O failure (connection error, timeout, 404).
    Never raises.
    """
    url = f"{api_base}/api/generate"
    payload = json.dumps({"model": model, "prompt": prompt, "stream": False}).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read())
            response_text = data.get("response", "")
            parsed = parse_critic_response(response_text)
            return build_critic_sentinel_field(
                model=model,
                verdict=parsed["verdict"],
                divergences=parsed["divergences"],
                missed_by_claude=parsed["missed_by_claude"],
            )
    except Exception as exc:
        print(f"[da-cross-model-critic] ollama call failed ({type(exc).__name__}: {exc}); SKIPPED",
              file=sys.stderr)
        return build_critic_sentinel_field(
            model=model,
            verdict="SKIPPED",
            divergences=[],
            missed_by_claude=[],
        )


def run_cross_critic(
    decision_summary: str,
    da_findings: str,
    *,
    model: str = DEFAULT_MODEL,
    api_base: str = DEFAULT_API_BASE,
    _check_availability: bool = True,
) -> dict:
    """Main entry point: build prompt, call ollama, return sentinel field.

    If `_check_availability` is True (default), probes ollama before the real
    call and tries FALLBACK_MODEL if the preferred model is absent.
    """
    if _check_availability:
        available_model = _resolve_model(model, api_base)
        if available_model is None:
            return build_critic_sentinel_field(
                model=model, verdict="SKIPPED", divergences=[], missed_by_claude=[]
            )
        model = available_model

    prompt = build_critic_prompt(decision_summary, da_findings)
    return call_ollama_critic(prompt=prompt, model=model, api_base=api_base)


def _resolve_model(preferred: str, api_base: str) -> str | None:
    """Return the best available model name, or None if ollama is unreachable."""
    try:
        req = urllib.request.Request(f"{api_base}/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            names = {m["name"] for m in data.get("models", [])}
    except Exception:
        return None

    if preferred in names:
        return preferred
    if FALLBACK_MODEL in names:
        print(f"[da-cross-model-critic] {preferred} not found, using {FALLBACK_MODEL}",
              file=sys.stderr)
        return FALLBACK_MODEL
    print(f"[da-cross-model-critic] neither {preferred} nor {FALLBACK_MODEL} available; SKIPPED",
          file=sys.stderr)
    return None


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main() -> None:
    parser = argparse.ArgumentParser(description="DA Phase-2 cross-model critic")
    parser.add_argument("--decision-summary", required=True)
    parser.add_argument("--findings", required=True, help="DA findings text (round 2/3)")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument("--sentinel", default=None,
                        help="Path to T3 sentinel JSON; if given, writes cross_model_critic field")
    args = parser.parse_args()

    result = run_cross_critic(
        args.decision_summary,
        args.findings,
        model=args.model,
        api_base=args.api_base,
    )

    if args.sentinel:
        try:
            with open(args.sentinel) as fh:
                sentinel = json.load(fh)
            sentinel["cross_model_critic"] = result
            with open(args.sentinel, "w") as fh:
                json.dump(sentinel, fh, indent=2)
            print(f"[da-cross-model-critic] sentinel updated: {args.sentinel}", file=sys.stderr)
        except Exception as exc:
            print(f"[da-cross-model-critic] sentinel write failed: {exc}", file=sys.stderr)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
