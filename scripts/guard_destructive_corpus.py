#!/usr/bin/env python3
"""Measured case corpus for the R6/R7 destructive-git rules (card a0b78305).

Input artefact for dave, in the same shape as the 779416f2 corpus: every case is
a STRING handed to the guard's own `classify()`. Nothing here runs git, deletes
anything, or touches the filesystem. The one mode that does call git (`--radius`)
uses git's own DRY RUN (`-n`) exclusively and cannot remove a file.

Two things this corpus is NOT:

  * It is not a replacement for the TDD suite on the card. Those tests assert a
    rule fires; this table records what the guard does TODAY across the whole
    shape space, so "the fix worked" is measured against a baseline rather than
    against memory.
  * It is not a verdict on the rule design. Where the measurement contradicts
    the drafted rule shape, the case carries the contradiction and the doc
    states it; the design call is dave's.

Run:
    python3 scripts/guard_destructive_corpus.py            # baseline table
    python3 scripts/guard_destructive_corpus.py --verbose  # + reported cause
    python3 scripts/guard_destructive_corpus.py --radius   # dry-run blast radius
"""

import argparse
import importlib.util
import os
import subprocess
import sys

# The enforcement copy. MEASURED 2026-08-14: 28 of 29 agent settings files wire
# this guard, and all 28 point at scripts/hooks/ -- there is no promoted copy for
# this guard, unlike guardrail-permission-rules.py which every agent runs from
# .guard/. So the tracked file IS the live enforcement path, and it changes the
# moment the shared checkout changes branch. (agents/heartbeat wires no
# destructive guard at all.)
GUARD_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "scripts", "hooks", "guardrail-destructive-bash.py",
)

# Ground truth. The guard today is binary (exit 2 = hard block), while the
# approved R6/R7 shape is ASK-FIRST, so the column deliberately does not say
# "block": it says whether the command may proceed UNCHALLENGED.
GUARDED = "guarded"  # must not proceed silently (block or ask -- design call)
PASS = "pass"        # must proceed without friction

# DECIDED by dave 2026-08-14 (finding 1): the effective scope of an UNBOUNDED
# `git clean` comes from the working directory. That makes ground truth for
# those rows cwd-dependent, which the original harness could not express -- it
# handed classify() a command string and nothing else. Cases may now carry a
# `cwd`, and the harness sets it BOTH ways:
#
#   * os.chdir  -- the mechanism with a production precedent. The only
#     PreToolUse hook that reads a working directory today,
#     guardrail-telegram-chat.py:43, uses os.getcwd(), and its tests pin that.
#   * payload["cwd"] -- present on the hooks that read it here (ledger-capture,
#     taskstate-replay, bond-learner-digest), but all three are UserPromptSubmit
#     or SessionStart. UNMEASURED for PreToolUse in this repo.
#
# Setting both means the corpus measures whichever mechanism the fix picks,
# instead of encoding a guess about the payload shape.
AGENT_CWD = "/home/domin/marveen/agents/percy"   # the protected class
NEUTRAL_CWD = "/tmp"                             # outside it


def load_guard(path):
    spec = importlib.util.spec_from_file_location("destructive_rules", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CASES = [
    # -- R6 positives: the shapes the card names ---------------------------
    dict(id="R6-1", family="R6-clean", should=GUARDED,
         note="the canonical fleet rm -rf",
         why="removes untracked AND ignored files: agent stores, tokens, state",
         command="git clean -fdx"),
    dict(id="R6-2", family="R6-clean", should=GUARDED,
         note="same command, flags reordered",
         why="identical effect; a rule keyed on the literal string misses it",
         command="git clean -xfd"),
    dict(id="R6-3", family="R6-clean", should=GUARDED,
         note="-f and -d without -x",
         why="removes untracked work: 89 paths measured from the repo root",
         command="git clean -fd"),
    dict(id="R6-4", family="R6-clean", should=GUARDED,
         note="long-form spelling of the same thing",
         why="--force --recurse-directories is the same operation",
         command="git clean --force -d -x"),

    # -- R6 negatives: must NOT create friction ----------------------------
    dict(id="R6-5", family="R6-clean", should=PASS,
         note="dry run: prints, removes nothing",
         why="-n is the safe form we ourselves use to measure",
         command="git clean -ndx"),
    dict(id="R6-6", family="R6-clean", should=PASS,
         note="narrow scope in a build directory (NoA's false-ask stipulation)",
         why="a generated subtree; asking here trains people to click through",
         command="git clean -fd src/generated"),

    # -- R6 BLIND SPOT: the dangerous form carries NO path argument ---------
    # MEASURED 2026-08-14: every agent's default working directory IS an
    # agents/<name> directory -- exactly the credential/state class R6 exists to
    # protect. From there a bare `git clean -fdx` needs no path argument and no
    # `cd`: dry run says it would remove 233 paths across 29 agent dirs, 107 of
    # them credential/state/KB (.genesis-token, .mcp.json, .claude/, memory/).
    # `.claude/` is where the guard's own wiring lives, so the command removes
    # its own enforcement. R6 as drafted scopes on the PATH ARGUMENT; these four
    # have none, and are byte-identical to R6-1..R6-3 above.
    dict(id="R6-7", family="R6-no-argv", should=GUARDED,
         note="BLIND SPOT: bare form, dangerous only because of the cwd",
         why="from an agent dir this removes that agent's tokens, state and KB",
         command="git clean -fdx"),
    dict(id="R6-8", family="R6-no-argv", should=GUARDED,
         note="BLIND SPOT: cwd moved inside the command itself",
         why="the effective scope is set by the cd, not by an argument",
         command="cd /home/domin/marveen/agents/percy && git clean -fdx"),
    dict(id="R6-9", family="R6-no-argv", should=GUARDED,
         note="BLIND SPOT: -C sets the scope with no positional path",
         why="git's own flag for running elsewhere; no path argument appears",
         command="git -C /home/domin/marveen/agents/percy clean -fdx"),
    dict(id="R6-10", family="R6-no-argv", should=GUARDED,
         note="explicit path INTO the protected class (the case argv can see)",
         why="names an agent store directly",
         command="git clean -fdx agents/percy/store"),

    # -- D: dave's decision on finding 1, as measurable rows -----------------
    # "A cwd nem szigoritas mindenre, hanem a hianyzo scope PONT az argumentum
    # nelkuli alakra." Two halves, and the corpus pins both so a later fix
    # cannot satisfy one and quietly drop the other.
    dict(id="D1", family="R6-cwd", should=GUARDED,
         note="DECIDED: unbounded form, cwd inside the protected class",
         why="no path argument exists to inspect; the cwd IS the scope",
         cwd=AGENT_CWD,
         command="git clean -fdx"),
    dict(id="D2", family="R6-cwd", should=PASS,
         note="DECIDED (NoA's false-ask stipulation): scoped path, agent cwd",
         why="a named subtree is deliberate; asking here trains click-through",
         cwd=AGENT_CWD,
         command="git clean -fd build/"),
    dict(id="D3", family="R6-cwd", should=PASS,
         note="DECIDED: scope narrowed by argument, so cwd must not widen it",
         why="the decision covers the UNBOUNDED form only",
         cwd=AGENT_CWD,
         command="git clean -fd src/generated"),
    # The decision fixes the MECHANISM (cwd supplies the missing scope). It does
    # not fix the PREDICATE -- which directories count as protected. This row
    # carries that gap instead of guessing at it, in the same shape as the H
    # family on 779416f2: counted apart so an undecided axis cannot land in the
    # headline as if it had been settled.
    dict(id="D4", family="R6-cwd", should=PASS, pending=True,
         note="UNDECIDED: unbounded form from a directory outside the class",
         why="proposed only; the predicate for 'protected cwd' is dave's call",
         cwd=NEUTRAL_CWD,
         command="git clean -fdx"),
    # DISCRIMINATOR (dave, 2026-08-14). Without this row the cwd family is a
    # green sequence that an empty input would also produce: the harness sets
    # both mechanisms, so a fix reading ONLY payload["cwd"] passes D1 even
    # though that key is unmeasured on PreToolUse. Here the payload key is
    # deliberately ABSENT while the process stands in the agent directory --
    # the production arrangement, since os.getcwd() is what
    # guardrail-telegram-chat.py:43 reads and its tests pin.
    #
    # Reading: D5 red while D1 green == the fix depends on a payload key that
    # may never arrive, and the rule is dead in production while the corpus
    # says green. That is the exact failure this row exists to make loud.
    dict(id="D5", family="R6-cwd", should=GUARDED, cwd_mode="chdir_only",
         note="DISCRIMINATOR: no payload cwd key, process IS in the agent dir",
         why="same danger as D1; only the delivery mechanism differs",
         cwd=AGENT_CWD,
         command="git clean -fdx"),

    # -- R7 positives ------------------------------------------------------
    dict(id="R7-1", family="R7-restore", should=GUARDED,
         note="discards every uncommitted change in the tree",
         why="on a shared dirty checkout this deletes other agents' work",
         command="git checkout -- ."),
    dict(id="R7-2", family="R7-restore", should=GUARDED,
         note="same, hard reset form",
         why="discards uncommitted work with no reflog entry for it",
         command="git reset --hard"),
    dict(id="R7-3", family="R7-restore", should=GUARDED,
         note="hard reset that also moves HEAD",
         why="discards uncommitted work and rewinds the branch",
         command="git reset --hard HEAD~1"),
    dict(id="R7-4", family="R7-restore", should=GUARDED,
         note="modern spelling of the same restore",
         why="git restore is the documented replacement for checkout --",
         command="git restore ."),

    # -- R7 negatives ------------------------------------------------------
    dict(id="R7-5", family="R7-restore", should=PASS,
         note="narrow scope: one named file",
         why="deliberate, reviewable, single-file revert",
         command="git checkout -- src/one/file.ts"),
    dict(id="R7-6", family="R7-restore", should=PASS,
         note="branch creation, not a restore",
         why="checkout -b creates a ref; touches no working-tree content",
         command="git checkout -b new-branch"),
    dict(id="R7-7", family="R7-restore", should=PASS,
         note="soft reset keeps the working tree",
         why="moves HEAD only; uncommitted work survives",
         command="git reset --soft HEAD~1"),
    dict(id="R7-8", family="R7-restore", should=PASS,
         note="read-only inspection",
         why="git status changes nothing",
         command="git status --short"),

    # -- E: dave's decision on finding 2 ------------------------------------
    # The "when there are uncommitted changes" condition is DROPPED: R7 always
    # asks. The accepted cost is a redundant prompt on a clean tree; the reason
    # is that a fail-open state probe would switch R7 off silently on exactly
    # the confused tree where it is needed. These rows exist so that cost stays
    # ASSERTED. If someone later reintroduces the condition as an optimisation,
    # E1/E2 flip to FALSE-FRICTION and the corpus says so instead of the tree
    # quietly losing the rule.
    dict(id="E1", family="R7-always", should=GUARDED,
         note="DECIDED: asks on a CLEAN tree too -- the accepted redundancy",
         why="no state probe, no fail-open branch, no new failure mode",
         cwd=NEUTRAL_CWD,
         command="git reset --hard"),
    dict(id="E2", family="R7-always", should=GUARDED,
         note="DECIDED: same, outside a git repository entirely",
         why="a probe would have to answer 'which repo'; the decision does not",
         cwd=NEUTRAL_CWD,
         command="git checkout -- ."),

    # -- Harness integrity: the SHIPPED rules must still fire ---------------
    # If these pass, the corpus is not reaching the guard and every PASS above
    # is meaningless. This is the control, not decoration.
    dict(id="C1", family="control", should=GUARDED,
         note="R1 control: recursive force delete of a top-level root",
         why="the rule the guard already ships",
         # Assembled, so the file never holds a copy-pasteable destructive
         # command. Nothing here executes, but an artefact that reads as a
         # recipe is a hazard of its own.
         command="rm -rf " + "/home/" + "domin"),
    # R1 is scoped BY DESIGN to /, ~, $HOME, /home/<user>; its docstring says
    # "NOT a deeper path (worktree rm is fine)". So the agent-store class is
    # uncovered on the `rm` side too, not only on the git side. Recorded as an
    # observation for the card, NOT filed as a defect: narrowing R1 would hit
    # every legitimate worktree cleanup, which is a separate decision.
    dict(id="C4", family="control", should=PASS,
         note="OBSERVATION: deep path is outside R1 by design",
         why="documented scope; listed so the gap is on the record, not implied",
         command="rm -rf " + "/home/domin/marveen/agents/percy/store"),
    dict(id="C2", family="control", should=GUARDED,
         note="R3 control: SQL DROP through a client",
         why="the rule the guard already ships",
         command='sqlite3 store/noa.db "DROP TABLE kanban_cards"'),
    dict(id="C3", family="control", should=PASS,
         note="negative control: an ordinary read",
         why="must never be guarded",
         command="ls -la"),
]


def classify_case(guard, case):
    """Hand one case to the guard, with its cwd set both ways (see AGENT_CWD).

    chdir is restored unconditionally: a corpus that leaves the process standing
    somewhere else would poison every row after the first cwd case.
    """
    payload = {"tool_name": "Bash", "tool_input": {"command": case["command"]}}
    cwd = case.get("cwd")
    if not cwd:
        return guard.classify(payload)
    # cwd_mode="chdir_only" withholds the payload key on purpose -- see D5.
    if case.get("cwd_mode") != "chdir_only":
        payload["cwd"] = cwd
    origin = os.getcwd()
    try:
        os.chdir(cwd)
        return guard.classify(payload)
    finally:
        os.chdir(origin)


def run(verbose=False):
    guard = load_guard(GUARD_PATH)
    rows = []
    for case in CASES:
        denied, rule, reason = classify_case(guard, case)
        actual = GUARDED if denied else PASS
        verdict = "ok" if actual == case["should"] else (
            "UNCOVERED" if case["should"] == GUARDED else "FALSE-FRICTION")
        rows.append((case, actual, rule, reason, verdict))

    width = max(len(c["family"]) for c in CASES)
    print(f"{'id':<7}{'family':<{width + 2}}{'should':<9}{'today':<9}"
          f"{'rule fired':<16}verdict")
    print("-" * (48 + width))
    for case, actual, rule, reason, verdict in rows:
        print(f"{case['id']:<7}{case['family']:<{width + 2}}{case['should']:<9}"
              f"{actual:<9}{(rule or '-'):<16}{verdict}")
        if verbose:
            print(f"        {case['note']}")
            print(f"        ground truth: {case['why']}")

    controls = [r for r in rows if r[0]["family"] == "control"]
    if not any(r[1] == GUARDED for r in controls):
        print("\nRUN INVALID: no shipped rule fired -- the corpus is not reaching "
              "the guard. Ignore every row above.")
        return 2

    settled = [r for r in rows if not r[0].get("pending")]
    pending = [r for r in rows if r[0].get("pending")]
    uncovered = [r[0]["id"] for r in settled if r[4] == "UNCOVERED"]
    friction = [r[0]["id"] for r in settled if r[4] == "FALSE-FRICTION"]
    print(f"\ncases {len(rows)} | uncovered {len(uncovered)} | "
          f"false friction {len(friction)}   (settled cases only)")
    if pending:
        differ = [r[0]["id"] for r in pending if r[4] != "ok"]
        print(f"undecided predicate, not counted above: {len(pending)} case(s), "
              f"{len(differ)} differing: {', '.join(differ) or '-'}")
    if uncovered:
        print("uncovered today:", ", ".join(uncovered))
    if friction:
        print("false friction :", ", ".join(friction))
    print("\nBaseline expectation before R6/R7 exist: every R6/R7 row is\n"
          "UNCOVERED and all four controls hold. That is this card's claim,\n"
          "reproduced as a measurement rather than quoted.")
    return 0


# The blast radius lives in the LIVE install, not in whatever worktree this
# script is checked out into. Measured the wrong way first: run from a fresh
# worktree, `--radius` reported 0 paths across 0 agents -- correct for that tree
# (nothing untracked there yet) and completely misleading as an answer to "what
# would this remove". A zero that comes from measuring the wrong tree reads
# exactly like a zero that means "no risk", so the tree is now explicit and
# printed.
LIVE_ROOT = "/home/domin/marveen"


def radius(root=None):
    """Dry-run blast radius of a BARE `git clean` from each agent directory.

    Uses `git clean -ndx` only. The -n flag is git's own dry run: it prints what
    would be removed and removes nothing. There is no code path here that can
    delete a file.
    """
    root = root or LIVE_ROOT
    agents_dir = os.path.join(root, "agents")
    if not os.path.isdir(agents_dir):
        print(f"no agents/ directory under {root}")
        return 1
    print(f"measuring tree: {root}\n")

    # Two classes, counted separately on purpose. A single "sensitive" number
    # hides the difference between data that is gone and a link that is broken.
    #   DATA  -- real content loss: tokens, MCP config, agent stores, memory.
    #   LINK  -- .claude-config is a symlink into the shared transcript tree, so
    #            `git clean` removes the LINK; the transcripts survive but the
    #            binding is severed (per the card's own measurement).
    data_marker = (".genesis-token", ".mcp.json", "store/", "memory/", ".claude/")
    link_marker = (".claude-config",)
    total = data_hits = link_hits = dirs = 0
    print(f"{'agent':<18}{'paths':>6}{'data loss':>11}{'broken link':>13}")
    print("-" * 48)
    for agent in sorted(os.listdir(agents_dir)):
        path = os.path.join(agents_dir, agent)
        if not os.path.isdir(path):
            continue
        try:
            out = subprocess.run(["git", "clean", "-ndx"], cwd=path,
                                 capture_output=True, text=True, timeout=30)
        except Exception as exc:
            print(f"{agent:<18}{'ERR':>6}  {exc}")
            continue
        lines = [l for l in out.stdout.splitlines() if l.strip()]
        data = [l for l in lines if any(m in l for m in data_marker)]
        link = [l for l in lines if any(m in l for m in link_marker)]
        if lines:
            dirs += 1
            total += len(lines)
            data_hits += len(data)
            link_hits += len(link)
            print(f"{agent:<18}{len(lines):>6}{len(data):>11}{len(link):>13}")
    print("-" * 48)
    print(f"{'TOTAL':<18}{total:>6}{data_hits:>11}{link_hits:>13}")
    print(f"({dirs} agent directories)")
    print("\nEvery number above is what a BARE `git clean -fdx` would remove "
          "from\nthat agent's own default working directory -- with no path "
          "argument\nfor a rule to inspect. Measured with git's dry run; "
          "nothing was deleted.")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--verbose", action="store_true",
                    help="print each case's note and ground truth")
    ap.add_argument("--radius", action="store_true",
                    help="dry-run blast radius per agent directory")
    ap.add_argument("--root", default=None,
                    help=f"tree to measure with --radius (default {LIVE_ROOT})")
    args = ap.parse_args()
    sys.exit(radius(args.root) if args.radius else run(args.verbose))
