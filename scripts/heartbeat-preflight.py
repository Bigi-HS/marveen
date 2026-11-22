#!/usr/bin/env python3
"""Heartbeat preflight -- N1 token-discipline (card 13f45c58, Option 3).

Consolidates the 5 mechanical heartbeat steps (mcp-probe, keepalive+gap,
autopilot tick, halt-consumer count, kanban-push) into ONE tool call and
emits a single VERDICT line so the LLM heartbeat can short-circuit to a
one-line transcript when there is genuinely nothing to reason about.

This does NOT skip any mandatory step -- every sub-step still runs every
heartbeat (kanban-push included). It only removes the per-heartbeat deep
LLM reasoning over 5 separate outputs, which is the real token sink for
the fleet's most expensive agent (marveen = Opus 4.8 1M, ~54% of fleet
token).

VERDICT semantics (last line of stdout, machine-readable):
  VERDICT=QUIET  ...   nothing actionable; LLM writes a one-line transcript,
                       NO Telegram, and stops. (Still: if a <channel> user
                       message is in context, the LLM answers it regardless.)
  VERDICT=ACT  reasons=...   at least one reason needs the LLM; act on it.
      reasons tokens: MCP_DEAD, GAP_RECOVERY, HALT:<n>, TICK_DRIVE,
                      TICK_STUCK, NUDGE_STALE:<n>, PREFLIGHT_ERROR

Exit code mirrors the verdict: 0 = QUIET, 1 = ACT, 2 = preflight-internal
error (treat as ACT / fall back to the legacy step-by-step prompt).
"""
import datetime
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEEPALIVE_LOG = "/tmp/keepalive-marveen.log"
GAP_RECOVERY_MIN = 40  # >= 2 missed */15 cycles (or >=4 missed */10) = stall
NUDGE_MIN_PRIORITY = {"high", "urgent"}  # only high/urgent delegated-stale escalate QUIET->ACT

# Regex to parse the counts line emitted by tick.py:
#   counts: mine=N nudgeable=M parked=P
_COUNTS_RE = re.compile(r"counts:\s+mine=(\d+)\s+nudgeable=(\d+)\s+parked=(\d+)")


def tick_reason(tick_out: str, nudge_hi: int) -> list:
    """Pure helper: derive tick-related reason tokens from tick stdout + kanban nudge_hi.

    Decision table (evaluated top to bottom, first match wins):
      1. STUCK-GATE TRIPPED present           -> ["TICK_STUCK"]
      2. idle=false present:
         a. counts line parseable:
            - nudgeable > 0 OR nudge_hi > 0   -> ["TICK_DRIVE"]
            - nudgeable == 0, nudge_hi == 0,
              mine > 0 (backlog only)          -> []  (AC1: no false QUIET->ACT)
            - otherwise (mine == 0 too)        -> []  (truly idle)
         b. counts line NOT parseable          -> ["TICK_DRIVE"]  (AC4 fail-safe)
      3. idle=true / nothing                  -> []
    """
    if "STUCK-GATE TRIPPED" in tick_out:
        return ["TICK_STUCK"]

    if "idle=false" not in tick_out:
        return []

    # idle=false: must parse the counts line to decide safely
    m = _COUNTS_RE.search(tick_out)
    if m is None:
        # AC4: parse failure -> fail toward ACT, never swallow to QUIET
        return ["TICK_DRIVE"]

    try:
        nudgeable = int(m.group(2))
    except (ValueError, AttributeError):
        # AC4: non-int field -> fail toward ACT
        return ["TICK_DRIVE"]

    if nudgeable > 0 or nudge_hi > 0:
        return ["TICK_DRIVE"]

    # nudgeable == 0 and nudge_hi == 0: MINE-only backlog, no actionable delegated work
    # AC1: do NOT force ACT for boss-pending / known-blocked big feature cards
    return []


def run(cmd, timeout=60):
    """Run a sub-step; return (exit_code, stdout+stderr). Never raises."""
    try:
        p = subprocess.run(
            cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except Exception as e:  # noqa: BLE001 -- preflight must be crash-proof
        return 99, f"<preflight-run-error: {e}>"


def keepalive_gap_minutes():
    """Minutes since the last timestamped keepalive line, then append a fresh one.
    Returns None if no parseable prior timestamp (first run / plain line)."""
    gap = None
    try:
        last = ""
        if os.path.exists(KEEPALIVE_LOG):
            with open(KEEPALIVE_LOG) as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
            last = lines[-1] if lines else ""
        m = re.search(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+\-]\d{2}:\d{2})", last)
        if m:
            prev = datetime.datetime.fromisoformat(m.group(1))
            now = datetime.datetime.now(prev.tzinfo)
            gap = (now - prev).total_seconds() / 60.0
    except Exception:  # noqa: BLE001
        gap = None
    try:
        now_iso = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
        with open(KEEPALIVE_LOG, "a") as f:
            f.write(f"keepalive {now_iso}\n")
    except Exception:  # noqa: BLE001
        pass
    return gap


def main():
    lines = []
    reasons = []

    # 1. MCP pipe health
    mcp_code, mcp_out = run([sys.executable, "scripts/mcp-health-probe.py"])
    lines.append(f"[mcp]   exit={mcp_code} :: {mcp_out.strip().splitlines()[0] if mcp_out.strip() else ''}")
    if mcp_code == 1:
        reasons.append("MCP_DEAD")

    # 2. Keepalive + gap / stall detection
    gap = keepalive_gap_minutes()
    gap_s = "n/a" if gap is None else f"{gap:.1f}m"
    lines.append(f"[keep]  gap_since_last={gap_s} (recovery threshold={GAP_RECOVERY_MIN}m)")
    if gap is not None and gap > GAP_RECOVERY_MIN:
        reasons.append("GAP_RECOVERY")

    # 3. Autopilot tick (subprocess runs here for side-effects; reason appended after
    #    step 5 once nudge_hi is known -- tick_reason() needs both values).
    tick_code, tick_out = run([sys.executable, "scripts/autopilot/tick.py", "marveen"])
    tick_head = tick_out.strip().splitlines()[0] if tick_out.strip() else ""
    lines.append(f"[tick]  exit={tick_code} :: {tick_head}")

    # 3b. Token-usage collect (folded in from the standalone token-usage-collect
    #     heartbeat -- it was a type=heartbeat LLM session 4x/hour just to run a
    #     deterministic script = ~96 Opus sessions/day of pure waste. Runs here
    #     every memoria-heartbeat instead. Preserve the failure-alert semantics.
    col_code, col_out = run([sys.executable, "scripts/token-usage-collect.py"])
    col_head = col_out.strip().splitlines()[-1] if col_out.strip() else ""
    lines.append(f"[collect] exit={col_code} :: {col_head}")
    if col_code != 0:
        reasons.append("COLLECT_FAIL")

    # 3c. Model-switch cache-bust detection (N1 token-discipline, card 985a6264)
    model_code, model_out = run([sys.executable, "scripts/model-switch-detect.py"])
    model_head = model_out.strip().splitlines()[0] if model_out.strip() else ""
    lines.append(f"[model]  exit={model_code} :: {model_head}")
    if model_code == 1:
        reasons.append("MODEL_SWITCH")

    # 4. Halt consumer (fleet-wide halted-agent markers; marveen holds Boss-TG)
    halt_code, halt_out = run([sys.executable, "scripts/autopilot/notify-halt.py", "count"])
    halt_n = halt_out.strip().splitlines()[-1].strip() if halt_out.strip() else "?"
    lines.append(f"[halt]  exit={halt_code} :: count={halt_n}")
    if halt_code == 1 or (halt_n.isdigit() and int(halt_n) > 0):
        reasons.append(f"HALT:{halt_n}")

    # 5. Kanban push (ALWAYS runs -- the hard rule is satisfied here). We only
    #    escalate QUIET->ACT for DELEGATED + stale + high/urgent nudgeable cards;
    #    normal/low long-stale delegated cards are NOT auto-nudged (false-nudge
    #    history, 5x). The LLM may still nudge from the NUDGEABLE block on ACT.
    kb_code, kb_out = run([sys.executable, "scripts/heartbeat-kanban-push.py"], timeout=90)
    nudge_hi = 0
    in_nudge = False
    for ln in kb_out.splitlines():
        if "NUDGEABLE" in ln and "--" in ln:
            in_nudge = True
            continue
        if "PARKED" in ln and "--" in ln:
            in_nudge = False
            continue
        if in_nudge:
            # row shape: "   39.2d waiting     high    13373343 marveen   ..."
            m = re.match(r"\s*([\d.]+)d\s+\S+\s+(\w+)\s+\S+\s+(\w+)", ln)
            if m:
                prio, owner = m.group(2), m.group(3)
                if prio in NUDGE_MIN_PRIORITY and owner != "marveen":
                    nudge_hi += 1
    kb_summary = ""
    for ln in kb_out.splitlines():
        if "STALE" in ln and "parked" in ln:
            kb_summary = ln.strip()
            break

    # Tick reason computed here (after nudge_hi is known from step 5 above).
    # tick_reason() is a pure helper: AC1 fix -- only ACT when genuinely drivable.
    reasons += tick_reason(tick_out, nudge_hi)
    lines.append(f"[kanban] {kb_summary} | delegated-stale high/urgent nudgeable={nudge_hi}")
    if nudge_hi > 0:
        reasons.append(f"NUDGE_STALE:{nudge_hi}")

    # 6. Task-level tier verdict (model-tiering, card 6fd1e40c / OPS-336).
    #    VERDICT-ONLY and advisory: it logs L0/L1/L2 for this tick and flags an
    #    L0-task-on-costlier-than-Haiku mismatch, but NEVER switches the model
    #    (Opus-promotion is Boss-gated/manual) and NEVER changes reasons/VERDICT.
    #    Signal: a non-empty `reasons` means this tick needs real reasoning (L1);
    #    an otherwise-quiet tick is L0 (Haiku-eligible).
    agent_id = os.environ.get("MAIN_AGENT_ID", "marveen")
    tier_cmd = [sys.executable, "scripts/task-level-check.py", agent_id,
                "--in-progress", "0"]
    if reasons:
        tier_cmd.append("--inter-agent-task")
    _, tier_out = run(tier_cmd)
    tier_head = tier_out.strip().splitlines()[-1] if tier_out.strip() else ""
    lines.append(f"[tier]  {tier_head}")

    # Verdict
    print("=== HEARTBEAT PREFLIGHT [marveen] " + datetime.datetime.now().astimezone().isoformat(timespec="seconds") + " ===")
    for ln in lines:
        print(ln)
    print("--- NOTE: a <channel> user message in context ALWAYS overrides this verdict (answer it first). ---")
    if reasons:
        print(f"VERDICT=ACT  reasons={','.join(reasons)}")
        return 1
    print("VERDICT=QUIET  (one-line transcript, no Telegram, stop)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"[preflight] INTERNAL ERROR: {e}")
        print("VERDICT=ACT  reasons=PREFLIGHT_ERROR")
        sys.exit(2)
