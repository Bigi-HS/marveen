#!/usr/bin/env python3
"""Lint: tmux session targets must be anchored -- and only where that is measured.

WHY THIS EXISTS (card OPS-106, incident 2026-08-04 04:56:52)

`tmux -t NAME` resolves in three steps: exact name, then PREFIX, then fnmatch.
So a command naming one session hits a different one as soon as the intended
session is absent -- and "absent" is the normal state around a restart, which is
exactly when these commands run. On this fleet `marveen` is a prefix of
`marveen-channels`, so:

  * `has-session -t marveen` returned 0 while `marveen` did NOT exist, because it  # tmux-anchor-lint: ignore
    matched the orchestrator's session. A liveness check that answers about a
    different process is worse than no check: fleet-supervisor logged
    "dashboard: session up but :3420 not responding" in exactly that state.
  * `kill-session -t marveen` then killed `marveen-channels`, rc=0, no message.  # tmux-anchor-lint: ignore

Measured 47 times in store/fleet-supervisor.log. Each one dropped Genesis's whole
conversation, because channels.sh deliberately starts without --continue, so this
was never mere downtime.

THE RULE IS PER-COMMAND AND MEASURED, AND IT TOOK THREE PASSES TO GET RIGHT

Full matrix, tmux 3.6, throwaway sessions, both a target and a `-channels`
sibling. The middle column is the target EXISTING, the right one is the target
ABSENT with the sibling alive -- which is the state a restart creates:

    command          -t NAME            -t '=NAME'        -t '=NAME:'
    has-session      lies (sibling)     correct           correct
    kill-session     kills sibling      correct           correct
    display-message  returns SIBLING    rc=0, EMPTY       correct
    capture-pane     reads sibling      rc=1 no pane      correct
    send-keys        TYPES INTO SIBLING rc=1 no pane      correct, loud if absent

Three passes, and each wrong version was wrong in the same way:

1. "Session targets get `=`, pane targets do not" -- a CATEGORY argument. Refuted
   by measurement: list-panes and list-windows take pane targets and resolve the
   anchor fine.
2. "`display-message`/`send-keys`/`capture-pane` must NEVER be anchored" -- this
   file's previous rule. Measured, but only on ONE form. Thor pointed out that
   `send-keys -t '=NAME:'` delivers correctly and refuses loudly, so the ban
   forbade the actual fix; extending his check to display-message and capture-pane
   showed the same. A verdict about a FORM had been written down as a verdict
   about a COMMAND.
3. What survives: one form, `=NAME:` (anchor plus session qualifier), correct
   everywhere. Bare `=NAME` is a pane target, which is why it cannot resolve for
   the pane family -- silently for display-message.

The unanchored row is the dangerous one and it is not a style issue: with the
target absent, `send-keys -t marveen` types the keystrokes into the orchestrator's
session at exit 0. 51 such call sites exist; the sweep is its own card, so this
lint REPORTS them with a count rather than failing on them yet.

To read a session attribute, still prefer `list-sessions -F` with an exact name
match: `display-message -t '=NAME:'` resolves correctly but returns rc=0 and an
empty string when the session is absent, so it cannot tell absence from failure.

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

# Measured: `=NAME` resolves correctly. `=NAME:` also works on these.
REQUIRE_ANCHOR = ("has-session", "kill-session")

# Measured: these need the anchor AND the session qualifier. Bare `=NAME` is a
# PANE target that cannot resolve -- and for display-message it fails at exit 0
# with an empty string, which is why an earlier version of this file banned the
# anchor here outright. That ban was generalised from ONE form and was wrong: it
# forbade the very fix. `=NAME:` delivers to the right session and refuses loudly
# when it is absent.
REQUIRE_QUALIFIED_ANCHOR = ("send-keys", "capture-pane", "display-message")

# Enforced (fails the run). The qualified-anchor family is reported but does not
# fail yet: 51 unanchored send-keys call sites exist and the sweep is its own
# card. Reported LOUDLY with a count -- a bound that is not printed reads as
# "covered everything".
ENFORCED = REQUIRE_ANCHOR

# Takes a session-ish target but the anchor behaviour is NOT measured here. Never
# rewritten automatically; a human decides.
UNMEASURED = ("switch-client", "attach-session")

IGNORE_MARKER = "tmux-anchor-lint: ignore"
SCAN_EXTENSIONS = (".sh", ".bash", ".py", ".ts", ".js", ".mjs", ".cjs")
SKIP_DIR_PARTS = ("node_modules", "/dist/", "/.git/", "/worktrees/", "/coverage/")

# The token right after -t, in every call shape this tree uses. Each example
# carries the exemption marker because each one IS the broken form, spelled out
# on purpose -- which is the same reason the marker exists at all.
#   shell     tmux kill-session -t "$S"                             # tmux-anchor-lint: ignore
#   TS array  ['has-session', '-t', session]                        # tmux-anchor-lint: ignore
#   TS string `${TMUX} kill-session -t ${session} 2>/dev/null`      # tmux-anchor-lint: ignore
#   python    ["tmux", "has-session", "-t", session]                # tmux-anchor-lint: ignore
#
# The trailing backtick of a TS template literal is excluded from the bare-token
# form; without that, the fix-it text suggests a target ending in a backtick and
# is unusable.
# `(?<![\w-])` keeps `-t` from matching inside a word: a comment mentioning
# "stuck-tool-call" was otherwise read as a target of `ool-call`.
_TARGET_RE = re.compile(
    r"""(?<![\w-])['"]?-t['"]?\s*,?\s*(`[^`]*`|'[^']*'|"[^"]*"|[^\s,)\]`]+)"""
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
    """Problem descriptions for one source line (enforced + advisory, mixed).

    Callers that need the split use check_line_split().
    """
    enforced, advisory = check_line_split(line)
    return enforced + advisory


def check_line_split(line: str) -> tuple[list[str], list[str]]:
    """Return (enforced, advisory) problem descriptions for one source line."""
    if IGNORE_MARKER in line:
        return [], []
    problems = []
    advisory = []

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

    def qualified_anchor_cmd(cmd, raw, target):
        if target.startswith("=") and ":" in target:
            return
        if not target.startswith("="):
            consequence = (
                "keystrokes land in another session at exit 0"
                if cmd == "send-keys" else
                "you read another session at exit 0"
            )
            advisory.append(
                f"{cmd} -t {raw}: unanchored, so when the named session is absent this "
                f'reaches the prefix SIBLING -- {consequence}. Use -t "={target}:" '
                f"(anchor AND session qualifier)."
            )
        else:
            advisory.append(
                f"{cmd} -t {raw}: anchored but NOT session-qualified -- bare `=NAME` is a "
                f'pane target that cannot resolve. Use -t "={target}:". '
                + ("display-message returns '' at exit 0 in this form, so the caller "
                   "records an empty measurement and compares clean."
                   if cmd == "display-message" else "It exits 1 with \"can't find pane\".")
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
    for cmd in REQUIRE_QUALIFIED_ANCHOR:
        scan(cmd, qualified_anchor_cmd)
    for cmd in UNMEASURED:
        scan(cmd, unmeasured_cmd)
    return problems, advisory


def iter_files(root: str, paths: list[str]):
    if paths:
        for p in paths:
            yield p
        return
    # Tracked files AND untracked-but-not-ignored ones. `git ls-files` alone was
    # the first version of this and it was blind exactly where it mattered: the
    # live tree carries 24 untracked operational scripts, among them
    # scripts/scout-watchdog.sh -- a RUNNING watchdog with an unanchored
    # has-session that the tracked-only scan reported as 0 findings. A guard that
    # cannot see its subject must not report clean; that is the failure class this
    # whole card is about, so it would have been a poor way to enforce it.
    try:
        out = subprocess.run(
            ["git", "-C", root, "ls-files"], capture_output=True, text=True, check=True
        ).stdout.splitlines()
        out += subprocess.run(
            ["git", "-C", root, "ls-files", "--others", "--exclude-standard"],
            capture_output=True, text=True, check=True,
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


def _load_baseline(path: str) -> set[str]:
    """Load accepted file:line keys from a baseline file.

    Lines starting with '#' are comments. Each other non-empty line is a
    'filepath:linenum' key (the first two colon-separated fields of the linter's
    output). Blank lines are ignored. Any finding whose key matches a baseline
    entry is suppressed and does NOT count as a new violation -- it is expected
    pre-existing debt tracked on a card, not a new regression.

    The baseline does NOT suppress advisory findings; those are always shown.
    """
    keys = set()
    try:
        with open(path) as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                # Accept bare 'file:lineno' or full 'file:lineno: description'
                parts = line.split(":", 2)
                if len(parts) >= 2:
                    keys.add(f"{parts[0]}:{parts[1]}")
    except FileNotFoundError:
        print(f"error: baseline file not found: {path}", file=sys.stderr)
        raise SystemExit(2)
    return keys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    ap.add_argument("--strict", action="store_true",
                    help="also fail on the send-keys/capture-pane/display-message family "
                         "(flip this on once that sweep lands)")
    ap.add_argument("--baseline", metavar="FILE",
                    help="path to baseline file; findings matching a baseline entry are "
                         "suppressed and do not cause exit 1 (pre-existing debt, not regressions)")
    ap.add_argument("--write-baseline", metavar="FILE",
                    help="write the current enforced findings as a baseline file and exit 0")
    ap.add_argument("paths", nargs="*")
    args = ap.parse_args()
    root = os.path.abspath(args.root)

    baseline: set[str] = set()
    if args.baseline:
        baseline = _load_baseline(args.baseline)

    findings = 0
    suppressed = 0
    advisories = []
    scanned = 0
    new_finding_lines = []
    for path in iter_files(root, args.paths):
        try:
            with open(path, errors="replace") as f:
                lines = f.readlines()
        except (IsADirectoryError, FileNotFoundError, PermissionError):
            continue
        scanned += 1
        rel = os.path.relpath(path, root)
        for n, line in enumerate(lines, 1):
            enforced, advisory = check_line_split(line)
            for problem in enforced:
                key = f"{rel}:{n}"
                if key in baseline:
                    suppressed += 1
                else:
                    findings += 1
                    new_finding_lines.append(f"{rel}:{n}: {problem}")
                    print(f"{rel}:{n}: {problem}")
            for problem in advisory:
                advisories.append(f"{rel}:{n}: {problem}")

    if args.write_baseline:
        with open(args.write_baseline, "w") as fh:
            fh.write("# tmux-anchor-lint baseline\n")
            fh.write("# Generated: see card OPS/043b3ca5\n")
            fh.write("# Date: 2026-08-04\n")
            fh.write("# Each entry is an ACCEPTED PRE-EXISTING violation (not a regression).\n")
            fh.write("# New violations not in this list cause exit 1.\n")
            fh.write("# Remove an entry here once the violation is fixed.\n")
            fh.write("# Do NOT add new violations here -- fix them instead.\n")
            fh.write("#\n")
            for entry in new_finding_lines:
                key = ":".join(entry.split(":")[:2])
                fh.write(f"{key}\n")
        print(f"baseline written: {args.write_baseline} ({findings} entries)", file=sys.stderr)
        return 0

    if advisories:
        # Printed in full, never summarised away. A bound that is not shown reads
        # as "we covered everything", which is the failure this lint exists for.
        print(f"\n--- ADVISORY ({len(advisories)}): pane-family targets, not yet enforced ---")
        print("These are REAL: with the named session absent, an unanchored send-keys")
        print("types into the prefix sibling at exit 0. The sweep is a separate card;")
        print("run with --strict to fail on them.")
        for a in advisories:
            print(a)

    summary_parts = [f"scanned {scanned} file(s)", f"{findings} new finding(s)"]
    if suppressed:
        summary_parts.append(f"{suppressed} baselined (expected pre-existing debt)")
    summary_parts.append(f"{len(advisories)} advisory")
    print(f"\n{', '.join(summary_parts)}", file=sys.stderr)
    if findings:
        return 1
    if args.strict and advisories:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
