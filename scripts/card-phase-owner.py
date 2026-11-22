#!/usr/bin/env python3
"""Pure helper: identify the CURRENT-PHASE nudge-target for a multi-phase card.

PROBLEM
-------
On a dev->gate->deploy card the description `Owner:` label names the card's
primary owner, which is often the LATER-phase actor (e.g. forge for a deploy
card).  Blindly nudging the desc owner when the card is still in dev-phase
pings the wrong person and silences the correct one.

This module resolves the question: given a card's status + description, WHO
should be nudged RIGHT NOW to advance it?

Phase/owner mapping (fleet-canonical as of 2026-11):
  dev    -> dave     (design + build; planned/in_progress without gate signals)
  gate   -> thor     (QA/SEC review; card waiting on gate approval)
  deploy -> forge    (live deploy; gate passed, waiting for deploy GO)
  ambiguous -> None  (conflicting signals; fail-CLOSED -- return None + reason)

USAGE
-----
As a library:
    from card_phase_owner import resolve_phase_owner
    result = resolve_phase_owner(card_dict)
    # result.holder: str | None,  result.phase: str,  result.reason: str

As a CLI:
    echo '{"status":"waiting","description":"gate-pass\\ndeploy-ready"}' | \\
        python3 scripts/card-phase-owner.py

EXIT CODES
----------
0 -> resolved (holder printed to stdout as JSON)
1 -> ambiguous/unresolvable (None holder; JSON with reason)

DESIGN CONSTRAINTS (non-negotiable, same class as guardrail-*.py)
-------------------------------------------------------------------
CWD-INDEPENDENT: all path anchoring via Path(__file__).resolve().parent.
  Never a CWD-relative constant -- this is a known fleet fail-open class
  (shared-cwd-dependent-path-guard-fail-open-and-green-for-wrong-reason-test-1120).
FAIL-CLOSED on ambiguity: conflicting or unrecognised signals -> holder=None
  + reason. Never guess. The caller must handle None explicitly.
PURE CORE: resolve_phase_owner() is side-effect free; tested in isolation.
MATCHED-SIGNAL-ONLY: signals are drawn from a closed, documented set. Unknown
  signal combos -> ambiguous, not a default.
"""
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# CWD-independent repo root anchor -- see design constraint above.
_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent  # scripts/ -> repo root

# ---------------------------------------------------------------------------
# Phase-signal patterns
# These are matched against the FULL card description (title + description
# concatenated, lowercased) so markers embedded anywhere in long descriptions
# are found. Patterns are intentionally conservative: false-negatives land in
# 'ambiguous' (fail-closed) rather than wrong-phase.
# ---------------------------------------------------------------------------

# Gate-phase signals: PR is open and waiting for a reviewer seat/approval.
# NOTE: 'gate-pass' and 'gate-passed' are NOT gate-phase signals -- they mean
# the gate has completed (deploy phase).  Only waiting/pending/review/block
# signals belong here.
_GATE_PHASE_RE = re.compile(
    r"gate[-_\s]?(waiting|pending|review|block|seat|dispatch|approval)|"
    r"waiting[- ]for[- ](gate|review|thor|qa|sec)|"
    r"gate[-_\s]phase|"
    r"pr[- ](open|submitted|sent)[^.]*gate|"
    r"needs?[- ](gate|review|qa|sec)",
    re.IGNORECASE,
)

# Deploy-phase signals: gate has passed, deploy is the next step.
_DEPLOY_PHASE_RE = re.compile(
    r"gate[-_\s]?(pass(ed)?|approved|green)|"
    r"deploy[-_\s]?(ready|pending|waiting|gated|phase)|"
    r"waiting[- ]for[- ](deploy|forge|go)|"
    r"deploy[-_\s]phase|"
    r"merge[-_\s]?(ready|approved)[^.]*deploy|"
    r"forge[-_\s]?(deploy|go|build)",
    re.IGNORECASE,
)

# Dev-phase signals: being built / designed.
_DEV_PHASE_RE = re.compile(
    r"in[- ]progress|"
    r"dev(elop(ment|ing)?)?[-_\s]phase|"
    r"building|implementing|"
    r"dave[-_\s]?(build|dev|owns?)|"
    r"wip\b",
    re.IGNORECASE,
)

# Card statuses that imply a certain phase in the ABSENCE of explicit signals.
_DEV_STATUSES = frozenset({"planned", "in_progress"})
_WAIT_STATUSES = frozenset({"waiting"})


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PhaseOwnerResult:
    """Immutable result of a phase-owner resolution attempt."""
    phase: str          # 'dev' | 'gate' | 'deploy' | 'ambiguous' | 'unknown'
    holder: Optional[str]  # 'dave' | 'thor' | 'forge' | None
    reason: str         # human-readable explanation; always set


def resolve_phase_owner(card: dict) -> PhaseOwnerResult:
    """Identify who to nudge for *card* right now.

    Args:
        card: a kanban card dict with at minimum 'status' and 'description'
              (and optionally 'title').  Extra fields are ignored.

    Returns:
        PhaseOwnerResult with .holder being the canonical agent id to nudge,
        or None when the phase is ambiguous/unresolvable (fail-CLOSED).

    This function is PURE: no I/O, no globals mutated.
    """
    if not isinstance(card, dict):
        return PhaseOwnerResult(
            phase="unknown",
            holder=None,
            reason="card must be a dict",
        )

    status = str(card.get("status") or "").strip().lower()
    title = card.get("title") or ""
    description = card.get("description") or ""
    # Grep the FULL description (never truncate -- heartbeat-kanban-push lesson).
    full_text = title + "\n" + description

    gate_signal = bool(_GATE_PHASE_RE.search(full_text))
    deploy_signal = bool(_DEPLOY_PHASE_RE.search(full_text))
    dev_signal = bool(_DEV_PHASE_RE.search(full_text))

    # Explicit signal count -- if more than one class fires, that is ambiguous.
    signal_count = sum([gate_signal, deploy_signal, dev_signal])

    # --- CASE 1: deploy-phase signal is present (most specific -> highest prio
    #             when unambiguous).
    if deploy_signal and not gate_signal and not dev_signal:
        return PhaseOwnerResult(
            phase="deploy",
            holder="forge",
            reason="deploy-phase signal found (gate passed, deploy pending); nudge forge",
        )

    # --- CASE 2: gate-phase signal without deploy signal.
    if gate_signal and not deploy_signal and not dev_signal:
        return PhaseOwnerResult(
            phase="gate",
            holder="thor",
            reason="gate-phase signal found (PR open, review pending); nudge thor",
        )

    # --- CASE 3: dev-phase signal without gate/deploy signals.
    if dev_signal and not gate_signal and not deploy_signal:
        return PhaseOwnerResult(
            phase="dev",
            holder="dave",
            reason="dev-phase signal found; nudge dave",
        )

    # --- CASE 4: no explicit phase signal -- fall back to status heuristic
    #             ONLY when status is unambiguous for a single phase.
    if signal_count == 0:
        if status in _DEV_STATUSES:
            return PhaseOwnerResult(
                phase="dev",
                holder="dave",
                reason=f"no phase signal in description; status='{status}' implies dev phase; nudge dave",
            )
        if status in _WAIT_STATUSES:
            # 'waiting' alone is ambiguous: could be waiting for gate OR deploy.
            return PhaseOwnerResult(
                phase="ambiguous",
                holder=None,
                reason=(
                    f"status='{status}' but no phase signal in description; "
                    "cannot determine whether this is gate-wait or deploy-wait; "
                    "add an explicit phase marker to the card description"
                ),
            )
        # Unknown/done status with no signals.
        return PhaseOwnerResult(
            phase="unknown",
            holder=None,
            reason=f"status='{status}' with no phase signals; cannot classify",
        )

    # --- CASE 5: multiple signals fire simultaneously -> ambiguous (fail-CLOSED).
    active = [
        name
        for name, flag in [("deploy", deploy_signal), ("gate", gate_signal), ("dev", dev_signal)]
        if flag
    ]
    return PhaseOwnerResult(
        phase="ambiguous",
        holder=None,
        reason=(
            f"conflicting phase signals detected: {active}; "
            "cannot safely determine current phase; clarify card description"
        ),
    )


# ---------------------------------------------------------------------------
# CLI shim
# ---------------------------------------------------------------------------

def _main():
    """Read a card JSON from stdin, resolve phase owner, print result.

    Exit 0 -> holder resolved; exit 1 -> ambiguous/None.
    """
    try:
        raw = sys.stdin.read()
        card = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        out = {"phase": "unknown", "holder": None, "reason": f"JSON parse error: {exc}"}
        print(json.dumps(out, ensure_ascii=False))
        sys.exit(1)

    result = resolve_phase_owner(card)
    print(json.dumps({
        "phase": result.phase,
        "holder": result.holder,
        "reason": result.reason,
    }, ensure_ascii=False))
    sys.exit(0 if result.holder is not None else 1)


if __name__ == "__main__":
    _main()
