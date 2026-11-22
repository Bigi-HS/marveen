#!/usr/bin/env python3
"""task_level_check -- fleet model-tiering verdict (card 6fd1e40c / OPS-336).

Spec: store/plan-fleet-model-tiering-2026-11-17.md section 3 (task-level
L0/L1/L2 thresholds) + section 4.A (heartbeat-preflight integration steps 4-5).

Classifies the CURRENT heartbeat/tick task into a tier:

  L0 (Haiku-eligible)  quiet tick / lookup / scan / monitoring -- no in_progress
                       card, no Boss-DM, no inter-agent task, no non-heartbeat
                       scheduled trigger.
  L1 (Sonnet/default)  any real-work trigger (in_progress card, Boss-DM,
                       inter-agent task, a type=task scheduled trigger).
  L2 (Opus)            EXPLICIT only -- a Boss Opus GO. Never inferred from load.

KEY DESIGN CONSTRAINT (plan section 1, forge dispatch): this is VERDICT-ONLY.
The verdict classifies and may emit an advisory, but it NEVER switches the
model. The Opus (L2) promotion is Boss-gated and manual, so ``auto_switch`` is
always False -- including for an L2 verdict. The cache-bust / model-switch
detection is a SEPARATE concern (card 985a6264, scripts/model-switch-detect.py)
and is intentionally not duplicated here.

The cache-bust / cost insight (spec step 5): when an L0 (lookup/quiet) task is
running on a model costlier than Haiku, emit an advisory so the operator can
consider a manual Haiku flip. Running L1+ work on a default-Opus agent (e.g.
dave) is legitimate and is NOT flagged.

CLI (advisory, always exits 0 -- it must never fail a heartbeat):
  python3 scripts/task-level-check.py <agent> [--model M] [--in-progress N]
      [--boss-dm] [--inter-agent-task] [--task-type T] [--opus-go] [--json]
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LEVEL_TIER = {"L0": 0, "L1": 1, "L2": 2}

# Ordered longest-wins is unnecessary: the three substrings are disjoint.
_MODEL_SUBSTR_TIER = (("haiku", 0), ("sonnet", 1), ("opus", 2))
_UNKNOWN_MODEL_TIER = 1  # conservative middle (Sonnet) when the model is unknown

# Size cap on the kanban helper output, checked BEFORE json.loads so a hostile
# or buggy oversized response is rejected without being parsed (card d59c8e20).
MAX_RESPONSE_BYTES = 2_000_000  # 2 MB -- far above any real board, below OOM range


def model_tier(model):
    """Map a model id / alias to a tier 0 (Haiku) / 1 (Sonnet) / 2 (Opus).

    Unknown or empty -> 1 (Sonnet), a conservative middle. The tier only drives
    the advisory text; it never affects the verdict-only invariant.
    """
    if not model:
        return _UNKNOWN_MODEL_TIER
    m = model.lower()
    for substr, tier in _MODEL_SUBSTR_TIER:
        if substr in m:
            return tier
    return _UNKNOWN_MODEL_TIER


def classify_task_level(*, in_progress_count=0, has_boss_dm=False,
                        has_inter_agent_task=False, scheduled_task_type=None,
                        explicit_opus_go=False):
    """Pure classifier -> 'L0' | 'L1' | 'L2'. No I/O, no model switching.

    L2 is explicit-only (an Opus GO); it is never inferred from workload.
    """
    if explicit_opus_go:
        return "L2"
    is_task_sched = bool(scheduled_task_type) and \
        str(scheduled_task_type).lower() != "heartbeat"
    if (in_progress_count and in_progress_count > 0) or has_boss_dm \
            or has_inter_agent_task or is_task_sched:
        return "L1"
    return "L0"


def task_level_check(agent_id, *, current_model=None, in_progress_count=0,
                     has_boss_dm=False, has_inter_agent_task=False,
                     scheduled_task_type=None, explicit_opus_go=False):
    """Return a verdict dict. VERDICT-ONLY: ``auto_switch`` is always False.

    The Opus (L2) promotion is Boss-gated and manual; this function classifies
    and advises, nothing more.
    """
    level = classify_task_level(
        in_progress_count=in_progress_count,
        has_boss_dm=has_boss_dm,
        has_inter_agent_task=has_inter_agent_task,
        scheduled_task_type=scheduled_task_type,
        explicit_opus_go=explicit_opus_go,
    )
    cur_tier = model_tier(current_model)

    advisory = None
    # Spec step 5: only the L0-task-on-costlier-than-Haiku mismatch is flagged.
    # A default-Opus agent running L1+ on Opus is legitimate and NOT flagged.
    if level == "L0" and cur_tier > 0:
        advisory = (
            f"L0 (Haiku-eligible) task running on {current_model or 'unknown'} "
            f"(tier {cur_tier}); consider a manual Haiku flip for lookup/quiet work"
        )

    return {
        "agent": agent_id,
        "level": level,
        "level_tier": LEVEL_TIER[level],
        "current_model": current_model,
        "current_tier": cur_tier,
        "advisory": advisory,
        # INVARIANT: verdict-only. Opus-promotion is Boss-gated/manual.
        "auto_switch": False,
    }


def _count_in_progress_from_payload(payload, agent_id, max_bytes=MAX_RESPONSE_BYTES):
    """Pure: count the agent's in_progress cards in a raw kanban payload (str).

    Fail-closed to 0 on an empty, oversized, or invalid payload. The size cap is
    checked BEFORE json.loads, so a hostile/huge response is rejected without
    being parsed -- this bounds the parse cost and the resulting object graph (no
    OOM). Cards key the owning agent on ``assignee`` (NOT ``owner``) -- see the
    reference memory ref-kanban-card-assignee-field-not-owner.
    """
    if not payload or len(payload) > max_bytes:
        return 0
    try:
        data = json.loads(payload)
    except Exception:  # noqa: BLE001 -- advisory path must never raise
        return 0
    cards = data.get("cards", data) if isinstance(data, dict) else data
    if not isinstance(cards, list):
        return 0
    return sum(
        1 for c in cards
        if isinstance(c, dict)
        and c.get("assignee") == agent_id
        and c.get("status") == "in_progress"
    )


def live_in_progress_count(agent_id):
    """Best-effort count of the agent's in_progress kanban cards.

    Reads the live board via the read-only helper (localhost API, 20s timeout),
    then size-bounds the raw output before parsing (see
    _count_in_progress_from_payload). Any failure returns 0 -- the verdict
    degrades to L0, which is advisory-only and never harmful.
    """
    try:
        import subprocess
        p = subprocess.run(
            [sys.executable, os.path.join(ROOT, "scripts", "api-get-helper.py"),
             "/api/kanban"],
            capture_output=True, text=True, timeout=20, cwd=ROOT,
        )
        if p.returncode != 0:
            return 0
        return _count_in_progress_from_payload(p.stdout, agent_id)
    except Exception:  # noqa: BLE001 -- advisory path must never raise
        return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fleet model-tiering task-level verdict")
    ap.add_argument("agent", help="agent_id to classify")
    ap.add_argument("--model", default=None,
                    help="current model id (default: read from agent-config if omitted)")
    ap.add_argument("--in-progress", type=int, default=None,
                    help="in_progress card count (default: live kanban query)")
    ap.add_argument("--boss-dm", action="store_true", help="a Boss-DM is in context")
    ap.add_argument("--inter-agent-task", action="store_true",
                    help="an inter-agent task message is pending")
    ap.add_argument("--task-type", default=None,
                    help="scheduled task type that triggered this run (e.g. task|heartbeat)")
    ap.add_argument("--opus-go", action="store_true",
                    help="an explicit Boss Opus GO (-> L2)")
    ap.add_argument("--json", action="store_true", help="emit the verdict as JSON")
    args = ap.parse_args(argv)

    in_progress = (args.in_progress if args.in_progress is not None
                   else live_in_progress_count(args.agent))
    current_model = args.model if args.model is not None \
        else _read_config_model(args.agent)

    verdict = task_level_check(
        args.agent,
        current_model=current_model,
        in_progress_count=in_progress,
        has_boss_dm=args.boss_dm,
        has_inter_agent_task=args.inter_agent_task,
        scheduled_task_type=args.task_type,
        explicit_opus_go=args.opus_go,
    )

    if args.json:
        print(json.dumps(verdict))
    else:
        # No "[tier]" label here -- the heartbeat-preflight wrapper owns the label.
        adv = f" :: ADVISORY: {verdict['advisory']}" if verdict["advisory"] else ""
        print(f"agent={verdict['agent']} model={verdict['current_model']} "
              f"VERDICT={verdict['level']} auto_switch={verdict['auto_switch']}{adv}")
    # Advisory-only: never fail the heartbeat.
    return 0


def _read_config_model(agent_id, root=ROOT):
    """Read the agent's configured model; None on failure.

    Tries agents/<id>/agent-config.json first, then agents/<id>-local/... --
    the orchestrator runs as MAIN_AGENT_ID ``marveen`` but lives in the
    ``marveen-local`` directory, so the ``-local`` fallback resolves it.
    """
    for sub in (agent_id, f"{agent_id}-local"):
        try:
            path = os.path.join(root, "agents", sub, "agent-config.json")
            with open(path, encoding="utf-8") as f:
                return json.load(f).get("model")
        except Exception:  # noqa: BLE001
            continue
    return None


if __name__ == "__main__":
    sys.exit(main())
