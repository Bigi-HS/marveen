#!/usr/bin/env python3
"""PreToolUse guardrail hook: the autopilot RISKY-GATE brake.

This is the SIBLING of guardrail-ask-first.py (NOT an edit of it -- see
store/autopilot-step3-risky-gate-design-20261027.md DECISION 1). The two hooks
are deliberately split because they have OPPOSITE fail directions and mixing
them in one file is the label-vs-behavior trap Thor rejects:

  - guardrail-ask-first.py gates a CLOSED ENUM of irreversible MCP tools by
    tool-NAME and is FAIL-OPEN ("a broken guard must never wedge an agent").
  - THIS hook is the autopilot BRAKE (spec-autopilot-fleet-20261027.md §2.3 /
    INV4 / INV7). It gates action CLASSES that are NOT identifiable by tool-name
    alone -- the risk lives in the ARGS (an inter-agent message whose CONTENT
    carries a risky instruction; a kanban status transition to `done`; a PARKED
    marker assignment; a shared-tier memory OVERWRITE). Its DANGEROUS direction
    is "a risky action slips through unapproved", so on a guarded surface it is
    FAIL-CLOSED (DECISION 2): grey-zone and internal error both BLOCK.

Fail-closed is SCOPED to the guarded surface only: a tool that does not touch a
guarded surface always passes (exit 0), so a guard bug can never brick unrelated
autopilot work. The gate fires ONLY on a positively-matched guarded surface.

When it blocks, it reuses the ask-first confirm-channel (the identical
`<token>.pending` / `<token>.approved` marker protocol + marveen approver,
ask-first-approver skill): block exit 2 with a reason on stderr, record a
pending marker, and only let the re-issued identical call through once a fresh
approval marker exists (one-shot consume).

The 4 new RISKY classes (§2.3, H2 tool-RISKY-parity):
  RK-01  send_agent_message whose CONTENT arg carries a deploy/delete/publish/
         external-write/merge instruction -> content-inspected via the merged,
         gate-passed scripts/autopilot/risky_content.py core.
  RK-02  kanban status transition -> "done".
  --     PARKED / awaiting-dominik marker assignment on a card/action.
  RK-03  shared-tier memory OVERWRITE (a NEW shared entry, and any hot/warm
         write, stay SAFE -- shared-artifact-write-guard split).

Block mechanism: exit 2 with a reason on stderr (fleet convention). Exit 0 =
allow. There is no network egress; the risky-content core is a pure substring
matcher (no catastrophic backtracking).
"""
import sys
import os
import json
import time
import hashlib

# Import the merged, gate-passed pure content classifier (PR #883). Keep the
# dependency explicit and local so a load failure on the guarded inter-agent
# surface fails CLOSED (see _content_is_risky), not open.
_HERE = os.path.dirname(os.path.abspath(__file__))
_AUTOPILOT = os.path.join(os.path.dirname(_HERE), "autopilot")
if _AUTOPILOT not in sys.path:
    sys.path.insert(0, _AUTOPILOT)

# ---------------------------------------------------------------------------
# Guarded surfaces. Each surface is keyed by a CLOSED set of named hook-target
# tool names (hard-coded frozensets, not config: the enforcement surface must
# not be widenable or disable-able from outside the reviewed code). A tool whose
# name is in NONE of these sets is not on a guarded surface and always passes.
#
# REGISTRATION: like the sibling guardrail-ask-first.py, these name the tools a
# future build wires in. Until a real named tool is registered the corresponding
# set stays empty and that surface is inert (an unknown tool passes through).
# The autopilot RISKY-GATE routes inter-agent sends through a NAMED
# `send_agent_message` tool (spec §2.3 RK-01(a)) and kanban/memory state changes
# through named helper tools, precisely so this hook can see the content/args.
# ---------------------------------------------------------------------------

# RK-01: inter-agent message send. Content arg inspected for risky instructions.
SEND_AGENT_MESSAGE_TOOLS = frozenset(
    {
        "send_agent_message",
    }
)
# Arg keys that may hold the message body, tried in order. First present
# string wins; if a send tool is matched but NO textual content can be located,
# that is the grey zone -> fail-closed (risky).
_CONTENT_KEYS = ("message", "content", "body", "text")

# RK-02 / PARKED: kanban card status/marker write.
KANBAN_WRITE_TOOLS = frozenset(
    {
        "kanban_update",
    }
)
# Arg keys that may carry the target status / marker. Status aliases are
# over-inclusive on purpose: a non-standard status-key name (final_status,
# target_status, to_status, ...) must NOT let a ->done transition slip past the
# RK-02 scan (Chad A2 fail-open hole). The RISKY decision still hinges on the
# normalized VALUE == "done", so a benign status on any of these keys stays SAFE.
_STATUS_KEYS = (
    "status",
    "to_status",
    "new_status",
    "final_status",
    "target_status",
    "set_status",
    "status_to",
)
_MARKER_KEYS = ("marker", "park", "parked", "tag", "label")
# Boolean/truthy park-signal keys. _first_str only sees STRING values, so a
# caller sending {park: True} (bool, or 1) would evade the string marker-check
# below (Thor FLAG RK-02 boolean-park bypass). Mirror RK-03's _OVERWRITE_KEYS
# _any_truthy pattern: any truthy value on one of these keys is a park -> RISKY,
# regardless of type. The string-case marker-check still runs afterwards.
_PARK_TRUTHY_KEYS = ("park", "parked")
# Marker substrings that make an assignment RISKY (autonomous park / done-adjacent).
_RISKY_MARKER_TOKENS = ("parked", "awaiting-dominik", "awaiting_dominik")
# The one status value that is RISKY. Status ADVANCE (planned->in_progress->
# waiting) and CREATE stay SAFE (§2.3 SAFE list).
_RISKY_STATUS = "done"

# RK-03: memory write. A shared-tier OVERWRITE is risky; a NEW shared entry and
# any hot/warm/cold write are SAFE.
MEMORY_WRITE_TOOLS = frozenset(
    {
        "memory_save",
    }
)
_TIER_KEYS = ("tier", "category", "scope")
_SHARED_TIER = "shared"
# Truthy on any of these arg keys => this write is an OVERWRITE of an existing
# entry (as opposed to a new append). Over-inclusive on purpose (fail-closed).
_OVERWRITE_KEYS = ("overwrite", "replace", "update_existing", "existing_id", "entry_id")

# All guarded tool names (union) -- the matched-surface test.
_GUARDED_TOOLS = SEND_AGENT_MESSAGE_TOOLS | KANBAN_WRITE_TOOLS | MEMORY_WRITE_TOOLS

# How long an approval marker is honored after creation. Bounds replay. Identical
# to the sibling hook so the two share the ask-first confirm-channel semantics.
APPROVAL_TTL_SECONDS = 900  # 15 minutes


def approvals_dir():
    """Directory holding pending/approved markers. MUST be outside every agent
    profile's Write allow (so an agent cannot self-approve via the permission
    layer). Shared with guardrail-ask-first.py. Overridable via env for tests
    ONLY -- the hook subprocess inherits Claude Code's environment, not the
    agent's shell, so the agent cannot set this at call time."""
    override = os.environ.get("ASK_APPROVALS_DIR")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".claude", "ask-approvals")


def action_token(tool_name, tool_input):
    """Stable, collision-resistant token binding an approval to THIS exact
    action. Canonical JSON (sorted keys, no insignificant whitespace) so the
    token is identical for the pending record and the agent's re-issued call."""
    canonical = json.dumps(
        {"tool": tool_name, "input": tool_input},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


def _first_str(tool_input, keys):
    """Return the first key in `keys` whose value is a non-empty string, else
    None. Pure."""
    for k in keys:
        v = tool_input.get(k)
        if isinstance(v, str) and v.strip():
            return v
    return None


def _any_truthy(tool_input, keys):
    """True if any key in `keys` is present with a truthy value. Pure."""
    for k in keys:
        if tool_input.get(k):
            return True
    return False


def _content_is_risky(text):
    """Delegate inter-agent content inspection to the merged risky_content core.
    FAIL-CLOSED: if the core cannot be imported/called on this guarded surface,
    treat the content as risky (we are already on the send surface, so a silent
    pass would be the dangerous direction)."""
    try:
        from risky_content import is_risky_instruction  # local import = fail-closed on ImportError
        risky, _ = is_risky_instruction(text)
        return bool(risky)
    except Exception:
        return True


def classify(payload):
    """Pure (modulo the risky_content substring core, which is itself pure).

    Returns (guarded, token, surface). `guarded` is True ONLY when the tool is on
    a guarded surface AND the args positively indicate a RISKY action (or are
    ambiguous on that surface -> fail-closed). A tool NOT on any guarded surface,
    or a guarded tool whose args positively prove SAFE, returns
    (False, "", surface). `surface` is a short label for the reason string.

    Grey-zone rule (§2.3): on a guarded surface, anything not positively SAFE is
    RISKY. Non-dict payload / non-dict tool_input on a NON-guarded tool pass
    through; on a GUARDED tool they are ambiguous -> risky (fail-closed)."""
    if not isinstance(payload, dict):
        return (False, "", "")
    tool_name = payload.get("tool_name")
    if tool_name not in _GUARDED_TOOLS:
        return (False, "", "")  # not on a guarded surface -> pass (scoped fail-closed)

    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        # Guarded tool with an un-inspectable arg blob -> cannot prove SAFE.
        return (True, action_token(tool_name, tool_input), _surface_of(tool_name))

    surface = _surface_of(tool_name)
    risky = _surface_is_risky(tool_name, tool_input)
    if not risky:
        return (False, "", surface)
    return (True, action_token(tool_name, tool_input), surface)


def _surface_of(tool_name):
    if tool_name in SEND_AGENT_MESSAGE_TOOLS:
        return "inter-agent-message"
    if tool_name in KANBAN_WRITE_TOOLS:
        return "kanban-status/marker"
    if tool_name in MEMORY_WRITE_TOOLS:
        return "shared-memory-write"
    return "guarded"


def _surface_is_risky(tool_name, tool_input):
    """Pure per-surface risk decision. Each branch is FAIL-CLOSED: it returns
    True unless the args positively establish the SAFE case."""
    if tool_name in SEND_AGENT_MESSAGE_TOOLS:
        content = _first_str(tool_input, _CONTENT_KEYS)
        if content is None:
            return True  # send surface with no inspectable content -> grey-zone risky
        return _content_is_risky(content)

    if tool_name in KANBAN_WRITE_TOOLS:
        # A PARKED / awaiting-dominik marker assignment is risky regardless of
        # status. FIRST catch a boolean/numeric park flag ({park: True}, park: 1):
        # _first_str below only inspects STRING values, so a non-string park
        # signal would evade it (Thor FLAG). This mirrors RK-03's _any_truthy use.
        if _any_truthy(tool_input, _PARK_TRUTHY_KEYS):
            return True
        marker = _first_str(tool_input, _MARKER_KEYS)
        if marker is not None:
            low = marker.strip().lower()
            if any(tok in low for tok in _RISKY_MARKER_TOKENS):
                return True
        status = _first_str(tool_input, _STATUS_KEYS)
        if status is None:
            # A kanban write that names no status and no marker is not a
            # done-transition / park -- it is a create / field edit -> SAFE.
            # (If it also had a risky marker we returned True above.)
            return False
        return status.strip().lower() == _RISKY_STATUS

    if tool_name in MEMORY_WRITE_TOOLS:
        tier = _first_str(tool_input, _TIER_KEYS)
        if tier is None:
            # Shared-overwrite disguised as a tier-less write -> cannot prove the
            # SAFE (non-shared / new) case on this guarded surface -> fail-closed.
            return True
        if tier.strip().lower() != _SHARED_TIER:
            return False  # hot/warm/cold write -> SAFE
        # Shared tier: only an OVERWRITE is risky; a new entry is SAFE.
        return _any_truthy(tool_input, _OVERWRITE_KEYS)

    # Unknown guarded tool (should not happen -- union is exact) -> fail-closed.
    return True


def approval_status(directory, token, now):
    """IO: classify the approval marker for `token`. Returns 'fresh' (exists and
    within TTL), 'stale' (exists but expired), or 'absent'."""
    path = os.path.join(directory, token + ".approved")
    try:
        mtime = os.stat(path).st_mtime
    except Exception:
        return "absent"
    if now - mtime <= APPROVAL_TTL_SECONDS:
        return "fresh"
    return "stale"


def decide(guarded, status):
    """Pure mapping from (guarded, approval status) to an action:
      'allow'   -> not guarded (not a guarded surface, or proven SAFE).
      'consume' -> guarded and a fresh approval exists; delete marker then allow.
      'block'   -> guarded and no fresh approval; record pending then block."""
    if not guarded:
        return "allow"
    if status == "fresh":
        return "consume"
    return "block"


def _reason(token, pending_path, tool_name, surface):
    return (
        "AUTOPILOT RISKY-GATE: '{tool}' ({surface}) is a RISKY autopilot action "
        "(deploy/delete/publish/external-write/merge instruction, kanban->done, "
        "PARKED-marker, or shared-memory overwrite) and may NOT run autonomously. "
        "A pending approval request was recorded as token={token} ({path}). Do NOT "
        "retry directly. Send an inter-agent message to marveen (Genesis) asking to "
        "approve token={token}, and summarize what this action does. marveen reviews "
        "the pending file and, if it is safe, creates the approval marker; then "
        "re-issue this exact call. This is the ask-first confirm-channel; do not "
        "bypass it. (If this is an inter-agent instruction, the receiving agent is "
        "the last line and must still ask-first itself.)".format(
            tool=tool_name, surface=surface, token=token, path=pending_path
        )
    )


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else None
    except Exception:
        # Unreadable/malformed input: we have NOT matched a guarded surface, so we
        # cannot be mid-risky-action -> pass (scoped fail-closed, like the sibling).
        sys.exit(0)

    # Determine guarded status first. If anything in classification throws, we do
    # NOT know whether we are on a guarded surface -- but classify() is written to
    # return fail-closed (True) for guarded-surface ambiguity, so an exception
    # here is a genuine guard bug. A guard bug must not brick unrelated work, yet
    # the brake's dangerous direction is letting a risky action through. We split
    # it: exceptions BEFORE we know the surface -> pass; once we know we are on a
    # guarded surface, any failure -> block.
    try:
        guarded, token, surface = classify(payload)
    except Exception:
        # Could not even classify. If the raw payload names a guarded tool, fail
        # CLOSED; otherwise pass (scoped).
        try:
            name = payload.get("tool_name") if isinstance(payload, dict) else None
        except Exception:
            name = None
        if name in _GUARDED_TOOLS:
            guarded, token, surface = True, _safe_token(name, payload), _surface_of(name)
        else:
            sys.exit(0)

    if not guarded:
        sys.exit(0)

    try:
        directory = approvals_dir()
        now = time.time()
        status = approval_status(directory, token, now)
        action = decide(guarded, status)

        if action == "consume":
            # One-shot: remove the marker so a later identical call needs fresh
            # approval. If removal fails we still allow this call; the TTL bounds
            # the replay window.
            try:
                os.remove(os.path.join(directory, token + ".approved"))
            except Exception:
                pass
            sys.exit(0)

        # action == 'block': record the exact action for marveen, then block.
        os.makedirs(directory, exist_ok=True)
        pending_path = os.path.join(directory, token + ".pending")
        with open(pending_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "token": token,
                    "surface": surface,
                    "tool_name": payload.get("tool_name") if isinstance(payload, dict) else None,
                    "tool_input": payload.get("tool_input") if isinstance(payload, dict) else None,
                    "recorded_at": int(now),
                },
                f,
                indent=2,
                ensure_ascii=False,
            )
    except Exception:
        # We ARE on a guarded surface (guarded is True) and could not complete the
        # ask-first bookkeeping. Dangerous direction = letting the risky action
        # through, so FAIL CLOSED: block with a generic reason even if we could
        # not write the pending file.
        sys.stderr.write(
            "AUTOPILOT RISKY-GATE: a guarded risky action was detected but the "
            "approval channel could not be prepared. Blocking (fail-closed). Ask "
            "marveen to approve this action manually before retrying.\n"
        )
        sys.exit(2)

    tool_name = payload.get("tool_name") if isinstance(payload, dict) else None
    sys.stderr.write(_reason(token, pending_path, tool_name, surface) + "\n")
    sys.exit(2)


def _safe_token(tool_name, payload):
    """Best-effort token when classify() threw but we know the tool is guarded."""
    try:
        return action_token(tool_name, payload.get("tool_input"))
    except Exception:
        return hashlib.sha256((tool_name or "").encode("utf-8")).hexdigest()[:32]


if __name__ == "__main__":
    main()
