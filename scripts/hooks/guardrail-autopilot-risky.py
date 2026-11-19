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
# Boolean/truthy park-signal keys. The string marker-scan below only inspects
# STRING values, so a caller sending {park: True} (bool, or 1) would evade it
# (Thor FLAG RK-02 boolean-park bypass). Mirror RK-03's intent-flag _any_truthy
# pattern: any truthy value on one of these keys is a park -> RISKY, regardless
# of type. The string-case marker-scan still runs afterwards.
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
# OVERWRITE signal keys, split by semantics so a degenerate value cannot slip a
# real overwrite past a truthiness check:
#   * INTENT flags: a boolean/int "yes, overwrite" switch. Truthy => overwrite.
#   * IDENTITY keys: naming WHICH existing entry to replace. PRESENCE (the key is
#     in the payload at all, even with a falsy id like 0 / "0") => overwrite. A
#     truthy-only check missed existing_id=0 (fail-open). Over-inclusive on
#     purpose (fail-closed): a tier-less/new write simply omits these keys.
_OVERWRITE_INTENT_KEYS = ("overwrite", "replace", "update_existing")
_OVERWRITE_IDENTITY_KEYS = ("existing_id", "entry_id")

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


# NOTE (card ab9b14db): the earlier _first_str helper (first present string over
# a key-list) was REMOVED. First-wins is a BYPASS shape -- a RISKY signal can hide
# on a LATER alias key ({status:'in_progress', final_status:'done'}, Chad #1036
# advisory) -- so every risk DECISION now uses the ALL-SCAN _scan_keys below. Any
# future key-list check MUST iterate all values (and nested ones), never stop at
# the first.

# Harvest bounds. A real tool-arg status/marker/content value is a scalar or a
# shallow list; these bounds only exist to stop a pathological blob (deep nesting,
# self-reference, or a huge fan-out list) from wedging or DoS-ing the guard.
# Hitting EITHER bound does NOT silently drop a value -- _scan_keys reports
# truncation so the deciders fail CLOSED (a value we could not inspect is risky).
_WALK_MAX_DEPTH = 24
_WALK_MAX_NODES = 2048  # total containers+strings visited per _scan_keys call


def _walk_strings(value, acc, budget, _depth=0):
    """Append every string buried anywhere inside `value` to `acc` -- a plain
    string, or any string nested in a list/tuple/set/dict (keys AND values).
    `budget` is a single-element [int] visit-counter shared across the whole
    scan. Returns True if a bound (depth OR node budget) cut the walk short with
    un-inspected structure remaining (truncated), else False. Pure except for
    mutating `acc` and `budget`.

    Type-confusion / resource-exhaustion defence (the GAP1 class): a caller can
    wrap a dangerous value in a list or sub-dict ({status:['done']},
    {marker:{x:'parked'}}) so a plain str-only check sees no string and the
    surface wrongly reads SAFE; or send a huge/deep blob to exhaust CPU. The node
    budget bounds total work; truncation makes any un-inspected value fail-closed."""
    if budget[0] <= 0:
        return isinstance(value, (dict, list, tuple, set, frozenset, str))
    budget[0] -= 1
    if isinstance(value, str):
        if value.strip():
            acc.append(value)
        return False
    if _depth >= _WALK_MAX_DEPTH:
        # There is still a container below that we refuse to descend into: we
        # cannot prove it SAFE -> signal truncation so the caller fails closed.
        return isinstance(value, (dict, list, tuple, set, frozenset))
    truncated = False
    if isinstance(value, dict):
        for k, v in value.items():
            # Budget guard BEFORE the key-append: int/non-str values recurse at
            # cost 1 and early-return without signalling truncation, so without
            # this break a 500k-key dict would append every key (truncated stays
            # False) and blow the per-string content check up to ~57s. Breaking
            # here fails the walk closed once the node budget is spent (Chad #1037).
            if budget[0] <= 0:
                truncated = True
                break
            if isinstance(k, str) and k.strip():
                acc.append(k)
            truncated = _walk_strings(v, acc, budget, _depth + 1) or truncated
        return truncated
    if isinstance(value, (list, tuple, set, frozenset)):
        for v in value:
            if budget[0] <= 0:
                truncated = True
                break
            truncated = _walk_strings(v, acc, budget, _depth + 1) or truncated
        return truncated
    # Scalars that are not strings (bool/int/float/None) carry no inspectable
    # text; the truthy-signal checks (_any_truthy) handle them separately.
    return False


def _scan_keys(tool_input, keys):
    """ALL-SCAN key-list harvester: return (strings, truncated) where
    `strings` is EVERY string reachable under any key in `keys` (recursing into
    nested lists/dicts, bounded by _WALK_MAX_DEPTH / _WALK_MAX_NODES) and
    `truncated` is True if a value was too deeply nested OR the node budget ran
    out before the walk finished. Pure. The risk decision must iterate `strings`
    (not stop at the first value) so a dangerous value on a later alias key or
    nested in a wrapper cannot hide (card ab9b14db); and must fail CLOSED on
    `truncated` so a value we could not fully inspect cannot slip through SAFE."""
    acc = []
    budget = [_WALK_MAX_NODES]
    truncated = False
    for k in keys:
        if k in tool_input:
            truncated = _walk_strings(tool_input.get(k), acc, budget) or truncated
    return acc, truncated


def _is_overwrite(tool_input):
    """True if the memory write targets an EXISTING shared entry (an overwrite),
    as opposed to a new append. Pure.

    Two semantics (see _OVERWRITE_INTENT_KEYS / _OVERWRITE_IDENTITY_KEYS):
      * intent flag truthy  -> overwrite (overwrite/replace/update_existing).
      * identity key PRESENT -> overwrite, even with a falsy id (existing_id=0 or
        ''): naming an entry at all means replacing it. A truthy-only check
        missed existing_id=0 (fail-open)."""
    if _any_truthy(tool_input, _OVERWRITE_INTENT_KEYS):
        return True
    return any(k in tool_input for k in _OVERWRITE_IDENTITY_KEYS)


def _any_truthy(tool_input, keys):
    """True if any key in `keys` is present with a truthy value. Pure.

    This is already an ALL-SCAN over `keys` (it returns on the FIRST truthy, but
    a truthy on ANY key -> True, so no risky value can hide behind an earlier
    benign key -- the correct direction for a fail-closed OR of park/overwrite
    signals)."""
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
        # ALL-SCAN: inspect EVERY string under any content key (incl. values
        # nested in a list/dict), not just the first. A caller could otherwise
        # hide a risky instruction on a later alias key or in a wrapper while a
        # benign value sits on an earlier key (card ab9b14db). If NO string is
        # present at all, the send surface has nothing to inspect -> grey-zone
        # fail-closed (risky).
        texts, truncated = _scan_keys(tool_input, _CONTENT_KEYS)
        if truncated:
            return True  # a content value too deeply nested to inspect -> fail-closed
        if not texts:
            return True  # send surface with no inspectable content -> grey-zone risky
        return any(_content_is_risky(t) for t in texts)

    if tool_name in KANBAN_WRITE_TOOLS:
        # A PARKED / awaiting-dominik marker assignment is risky regardless of
        # status. FIRST catch a boolean/numeric park flag ({park: True}, park: 1):
        # a STRING-only check would miss a non-string park signal (Thor FLAG).
        # This mirrors RK-03's _any_truthy use.
        if _any_truthy(tool_input, _PARK_TRUTHY_KEYS):
            return True
        # ALL-SCAN the marker keys: any risky marker token on ANY marker-key
        # alias (or nested in a list/dict) is a park -> risky. First-wins here was
        # a bypass ({marker:'backend', label:'parked'} hid the park on `label`).
        markers, m_trunc = _scan_keys(tool_input, _MARKER_KEYS)
        if m_trunc:
            return True  # marker value too deeply nested to inspect -> fail-closed
        for marker in markers:
            low = marker.strip().lower()
            if any(tok in low for tok in _RISKY_MARKER_TOKENS):
                return True
        # ALL-SCAN the status keys: if ANY status-key value normalizes to "done"
        # it is a ->done transition -> risky, even if an earlier alias key carries
        # a benign status ({status:'in_progress', final_status:'done'} -- the
        # Chad #1036 / card ab9b14db core bug). Value-normalization is preserved
        # so a benign status on any key, and prose fields, stay SAFE.
        statuses, s_trunc = _scan_keys(tool_input, _STATUS_KEYS)
        if s_trunc:
            return True  # status value too deeply nested to inspect -> fail-closed
        if not statuses:
            # A kanban write that names no status and no marker is not a
            # done-transition / park -- it is a create / field edit -> SAFE.
            # (If it also had a risky marker we returned True above.)
            return False
        return any(s.strip().lower() == _RISKY_STATUS for s in statuses)

    if tool_name in MEMORY_WRITE_TOOLS:
        # ALL-SCAN the tier keys: the write is on the shared tier if ANY tier-key
        # value normalizes to "shared", even if an earlier alias key carries a
        # benign tier ({tier:'hot', category:'shared'} hid the shared tier on
        # `category`). First-wins let that overwrite through as SAFE.
        tier_strs, t_trunc = _scan_keys(tool_input, _TIER_KEYS)
        if t_trunc:
            return True  # tier value too deeply nested to inspect -> fail-closed
        tiers = [t.strip().lower() for t in tier_strs]
        if not tiers:
            # Shared-overwrite disguised as a tier-less write -> cannot prove the
            # SAFE (non-shared / new) case on this guarded surface -> fail-closed.
            return True
        if _SHARED_TIER not in tiers:
            return False  # purely hot/warm/cold write -> SAFE
        # Shared tier present: only an OVERWRITE is risky; a new entry is SAFE.
        return _is_overwrite(tool_input)

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
