# R6/R7 case corpus and pre-implementation measurements (card a0b78305)

Input artefact for dave, measured 2026-08-14 before any R6/R7 code exists. Same
shape as the 779416f2 corpus: `scripts/guard_destructive_corpus.py` hands
strings to the guard's own `classify()` and never executes a command. The one
mode that calls git (`--radius`) uses git's dry run (`-n`) exclusively.

Baseline today: **22 cases, 12 uncovered, 0 false friction, 4/4 controls
correct.** The twelve uncovered rows are exactly the R6/R7 shapes, which
reproduces the card's claim as a measurement instead of quoting it.

The four findings below are ordered by how much they change what gets written.

---

## 1. The dangerous `git clean` carries no path argument

R6 is drafted to fire when "the scope is the repo root or touches a
credential/state/agents-store path". That is a test on the **path argument**.

Measured: **every agent's default working directory already IS an
`agents/<name>` directory** -- the exact class R6 exists to protect. From there
the destructive form needs no path argument and no `cd`. `--radius`, across 29
agent directories:

| | count |
|---|---|
| paths a bare `git clean -fdx` would remove | **233** |
| of those, real data loss (`.genesis-token`, `.mcp.json`, `store/`, `memory/`, `.claude/`) | **107** |
| of those, severed symlinks (`.claude-config` -> shared transcript tree) | **27** |

The two classes are counted apart on purpose: the symlink removal breaks the
binding but the transcripts themselves survive, so folding them into one
"sensitive" number would overstate the loss.

`.claude/` is in the data column, and it is where each agent's hook wiring
lives -- including the wiring for this guard. The command removes its own
enforcement.

Three shapes in the corpus carry this, and none of them is reachable by an
argv-scoped test:

- `R6-7` bare `git clean -fdx` -- byte-identical to `R6-1`, dangerous only
  because of where the process is standing
- `R6-8` `cd <agent dir> && git clean -fdx` -- scope set by the `cd`
- `R6-9` `git -C <agent dir> clean -fdx` -- git's own flag, still no positional

**What this implies for the rule shape.** The effective scope is a function of
three inputs: the hook process's cwd, any `cd`/`-C` inside the command, and the
path arguments. Only the third is in the drafted test. A PreToolUse hook can
read the first (`guardrail-telegram-chat.py` already relies on `os.getcwd()` in
production, and its tests pin that behaviour), so the information is available
-- it just is not in the current draft.

The inverse risk is real too: if scope is read from cwd, then `git clean -fd
build/` run from an agent directory would ask, which is precisely the false-ask
NoA ruled out. Both directions need a case, and `R6-6` is the one that pins the
quiet side.

---

## 2. R7's condition is repository state, not command text

R7 is drafted to fire "when there are uncommitted changes". `classify()` is pure
over `tool_input.command`; nothing in the payload carries repo state.

Satisfying the condition means shelling out to git from inside a PreToolUse
hook, which adds three questions the draft does not answer:

1. **Which repo?** The answer depends on cwd again -- see finding 1.
2. **What if the git call fails** (not a repo, git slow, lock contention)? This
   guard fails **open** everywhere else by explicit design, and says so loudly
   on stderr. A state probe that fails open turns R7 off silently in exactly the
   confusing situations where a shared dirty checkout is most likely.
3. **What does the message say when the probe fails?** On 779416f2 the measured
   defect was not the fail-closed branch itself but that it reported a *false
   cause* -- naming a `.env` file for a command that opened none. A state probe
   has the same failure mode available to it.

The cheap alternative is worth pricing: drop the condition and always ask on
`git reset --hard` / `git checkout -- .`. On a clean tree that is a redundant
prompt, and redundant prompts are how ask-tiers get click-through -- but it
needs no state, no subprocess and no new failure mode. This is a design call,
not a measurement, so it is dave's.

---

## 3. This guard has no ask tier, and the approved shape is ask-first

NoA approved R6/R7 as **ask-first, not hard-block**. The target file cannot
express that today:

- `guardrail-destructive-bash.py` is binary. `classify()` returns
  `(denied, name, reason)`; `main()` exits 0 or exits 2. The block message
  states, verbatim, that the action *"has no agent-level approval path"*.
  Adding R6/R7 as-is would hard-block a legitimate operation and tell the agent
  there is no way to proceed.
- The fleet's actual ask tier is `guardrail-ask-first.py`: a one-shot approval
  marker (write a marker file, the guarded call consumes it and proceeds). It is
  wired on `mcp__.*` only -- **not on Bash**.

So there is a decision before the TDD: extend the ask-first hook to Bash, grow a
second verdict type in the destructive guard, or accept hard-block and revisit
the approved shape with NoA. Whichever is chosen changes what the tests assert,
which is why this is worth settling first.

The corpus deliberately does not prejudge it: the ground-truth column says
`guarded` (must not proceed unchallenged), never `block`.

---

## 4. This guard runs from the tracked tree, with no promoted copy

Measured across all 29 agent settings files:

- **28 of 29** wire `guardrail-destructive-bash.py`, and **all 28 point at
  `scripts/hooks/`** -- the tracked working tree. There is no `.guard/` copy for
  this guard.
- **`agents/heartbeat` wires no destructive guard at all.**

This is the mirror image of the 779416f2 finding. There, the live guard was a
promoted, gitignored copy that had drifted ahead of `develop`. Here there is no
promotion step, so R6/R7 take effect for 28 agents the moment the shared
checkout contains them -- and stop applying if the checkout moves to a branch
without them. The enforcement version is whatever branch the shared tree happens
to be standing on.

Two consequences for the deploy plan on the card:

- Steps (3) and (4) -- promote plus extending `DEFAULT_GUARDS` -- would **move**
  these 28 agents from tracked-path to promoted-path enforcement. That is a
  behavioural change in how the guard is delivered, not plumbing, and it is
  worth a line in the commit rather than arriving as a side effect.
- `heartbeat` stays unguarded under either delivery model. Whether that is
  intentional is not something this corpus can tell.

---

## 5. What this corpus cannot see

- **22 hand-written shapes, not a population.** `git clean` and `git reset` have
  more spellings than are listed; an absent shape is unmeasured, not safe.
- **`git stash` is deliberately excluded**, per the card. It restores the tree
  under other agents on a shared checkout, and the corpus records no opinion.
- **Static classification only.** Every row measures the *decision*. It never
  measures what a command that slips through would actually remove -- that is
  what `--radius` is for, and those two measurements are separate.
- **One tree, one moment.** `--radius` measured `/home/domin/marveen` at
  02:00 on 2026-08-14. The card already notes the number is not stationary:
  untracked files appear continuously, so the mechanism is the finding, not
  the total. Measured the wrong way first, too -- run from a fresh worktree,
  `--radius` reported 0 paths across 0 agents, which was correct for that tree
  and entirely misleading as an answer. The measured tree is now printed.
- **R1's scope is unchanged and unchallenged.** `C4` records that a deep path
  such as an agent store is outside R1 by design ("worktree rm is fine"), so the
  agent-store class is uncovered on the `rm` side as well. Recorded as an
  observation, not filed as a defect: narrowing R1 would hit every legitimate
  worktree cleanup, which is a separate decision.
