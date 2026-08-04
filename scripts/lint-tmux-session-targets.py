#!/usr/bin/env python3
"""Lint: tmux session targets must be anchored -- and only where that is measured.

WHY THIS EXISTS (card OPS-106, incident 2026-08-04 04:56:52)

`tmux -t NAME` resolves in three steps: exact name, then PREFIX, then fnmatch.
So a command naming one session hits a different one as soon as the intended
session is absent -- and "absent" is the normal state around a restart, which is
exactly when these commands run. On this fleet `marveen` is a prefix of
`marveen-channels`, so:

  * `has-session -t marveen` returned 0 while `marveen` did NOT exist, because it
    matched the orchestrator's session. A liveness check that answers about a
    different process is worse than no check: fleet-supervisor logged
    "dashboard: session up but :3420 not responding" in exactly that state.
  * `kill-session -t marveen` then killed `marveen-channels`, rc=0, no message.

Measured 47 times in store/fleet-supervisor.log. Each one dropped Genesis's whole
conversation, because channels.sh deliberately starts without --continue, so this
was never mere downtime.

THE RULE IS PER-COMMAND AND MEASURED, NOT A BLANKET '=' SWEEP

`=NAME` against a session that EXISTS, tmux 3.6, measured independently by Forge
and again here before this file was written:

    command           result                            verdict
    kill-session      rc=0, exact, sibling survives      REQUIRE the anchor
    has-session       rc=0, correct                      REQUIRE the anchor
    list-windows      rc=0, resolves                     anchor harmless
    list-panes        rc=0, resolves                     anchor harmless
    display-message   rc=0, output ''                    NEVER -- FAILS SILENTLY
    capture-pane      rc=1, "can't find pane: =NAME"     never, but fails loudly
    send-keys         rc=1, "can't find pane: =NAME"     never, but fails loudly

Two things follow, and the second is the one that matters.

1. "Pane-target commands break with =" is the wrong split: list-panes and
   list-windows take pane/window targets and accept the anchor fine. Only the
   measured table predicts behaviour, so this lint carries the table.

2. Classify by FAILURE MODE. Six of the seven either work or fail loudly. Only
   `display-message` fails SILENTLY -- rc=0 and an empty string, on a session
   that exists -- which is why an anchored probe reads as "absent" and a
   `$(probe || echo absent)` caller records ''. That shape got past three of us
   on the same night. So an unmeasured command is never auto-required into the
   anchor; it is flagged for a human. A fix that guesses is the failure class we
   are trying to kill.

To read a session attribute, use `list-sessions -F` and match the name exactly:
a missing session then produces no line at all, which keeps absence
distinguishable from failure.

Usage:
    python3 scripts/lint-tmux-session-targets.py [--root DIR] [paths...]

Exit 0 clean, 1 on findings. Add `tmux-anchor-lint: ignore` to a line to exempt
it (fixtures, and documentation of the broken form).
"""
import argparse
import os
import re
import subprocess
import sys

# Measured: the anchor is correct AND the unanchored form is dangerous.
REQUIRE_ANCHOR = ("has-session", "kill-session")

# Measured: the anchor cannot resolve. `display-message` is called out on its own
# because it is the only one that fails silently, which is what makes it the
# dangerous "hardening" to apply by mistake.
NEVER_ANCHOR = {
    "display-message": "it prints '' at exit 0 on a session that EXISTS, so the "
                       "caller records an empty measurement and compares clean",
    "capture-pane": "it exits 1 with \"can't find pane\"",
    "send-keys": "it exits 1 with \"can't find pane\"",
}

# Takes a session-ish target but the anchor behaviour is NOT measured here. Never
# rewritten automatically; a human decides.
UNMEASURED = ("switch-client", "attach-session")

IGNORE_MARKER = "tmux-anchor-lint: ignore"
SCAN_EXTENSIONS = (".sh", ".bash", ".py", ".ts", ".js", ".mjs", ".cjs")
SKIP_DIR_PARTS = ("node_modules", "/dist/", "/.git/", "/worktrees/", "/coverage/")

# The token right after -t, in every call shape this tree uses:
#   shell     tmux kill-session -t "$S"
#   TS array  ['has-session', '-t', session]
#   TS string `${TMUX} kill-session -t ${session} 2>/dev/null`
#   python    ["tmux", "has-session", "-t", session]
# The trailing backtick of a TS template literal is excluded from the bare-token
# form, otherwise `kill-session -t ${session}\`` suggests a target ending in a
# backtick and the fix-it text is unusable.
_TARGET_RE = re.compile(
    r"""['"]?-t['"]?\s*,?\s*(`[^`]*`|'[^']*'|"[^"]*"|[^\s,)\]`]+)"""
)


def _strip_quotes(tok: str) -> str:
    # Drop a python string prefix first (f"={s}", rb'...'), otherwise the anchored
    # f-string form reads as unanchored and the lint flags its own fix.
    tok = re.sub(r"^[fFrRbBuU]{1,2}(?=['\"])", "", tok)
    if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in "'\"`":
        return tok[1:-1]
    return tok


def _target_after(line: str, end: int):
    """Return (raw_token, stripped) for the -t argument following `end`, or None."""
    rest = line[end:]
    m = _TARGET_RE.search(rest)
    if not m:
        return None
    return m.group(1), _strip_quotes(m.group(1))


def check_line(line: str) -> list[str]:
    """Return a list of problem descriptions for one source line."""
    if IGNORE_MARKER in line:
        return []
    problems = []

    def scan(cmd, handler):
        for m in re.finditer(r"\b%s\b" % re.escape(cmd), line):
            found = _target_after(line, m.end())
            if found is None:
                # A line the parser cannot read must fail loudly. A lint that
                # quietly passes what it could not see is this card's own bug.
                if re.search(r"['\"]?-t\b", line[m.end():]):
                    problems.append(
                        f"{cmd}: found -t but could not read its target -- put the "
                        f"target on the same line, or mark it `{IGNORE_MARKER}`"
                    )
                continue
            handler(cmd, *found)

    def session_cmd(cmd, raw, target):
        if not target.startswith("="):
            problems.append(
                f"{cmd} -t {raw}: SESSION target is unanchored, so tmux falls back to "
                f'prefix matching when it is absent and hits a sibling. Use -t "={target}".'
            )

    def never_anchor_cmd(cmd, raw, target):
        if target.startswith("="):
            problems.append(
                f"{cmd} -t {raw}: must NOT be anchored -- {NEVER_ANCHOR[cmd]}. "
                f"To read a session attribute use `list-sessions -F` with an exact "
                f"name match, which distinguishes absence from failure."
            )

    def unmeasured_cmd(cmd, raw, target):
        if not target.startswith("="):
            problems.append(
                f"{cmd} -t {raw}: anchor behaviour for this command is NOT measured on "
                f"this tmux. Measure it and add it to REQUIRE_ANCHOR or NEVER_ANCHOR, or "
                f"mark the line `{IGNORE_MARKER}` with the reason. Do not guess."
            )

    for cmd in REQUIRE_ANCHOR:
        scan(cmd, session_cmd)
    for cmd in NEVER_ANCHOR:
        scan(cmd, never_anchor_cmd)
    for cmd in UNMEASURED:
        scan(cmd, unmeasured_cmd)
    return problems


def iter_files(root: str, paths: list[str]):
    if paths:
        for p in paths:
            yield p
        return
    try:
        out = subprocess.run(
            ["git", "-C", root, "ls-files"], capture_output=True, text=True, check=True
        ).stdout.splitlines()
    except Exception:
        out = []
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                out.append(os.path.relpath(os.path.join(dirpath, fn), root))
    for rel in out:
        if not rel.endswith(SCAN_EXTENSIONS):
            continue
        if any(part in "/" + rel for part in SKIP_DIR_PARTS):
            continue
        yield os.path.join(root, rel)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    ap.add_argument("paths", nargs="*")
    args = ap.parse_args()
    root = os.path.abspath(args.root)

    findings = 0
    scanned = 0
    for path in iter_files(root, args.paths):
        try:
            with open(path, errors="replace") as f:
                lines = f.readlines()
        except (IsADirectoryError, FileNotFoundError, PermissionError):
            continue
        scanned += 1
        for n, line in enumerate(lines, 1):
            for problem in check_line(line):
                findings += 1
                print(f"{os.path.relpath(path, root)}:{n}: {problem}")

    print(f"\nscanned {scanned} file(s), {findings} finding(s)", file=sys.stderr)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
