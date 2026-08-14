# Guardrail false-positive corpus (input to card 779416f2)

Built by rackham, 2026-08-14, at marveen's request: validate dave's fix against
**measured** benign cases rather than assumed ones.

Harness: `scripts/guard_fp_corpus.py` (28 cases, runs in <1s, executes nothing).

```
python3 scripts/guard_fp_corpus.py            # table + summary
python3 scripts/guard_fp_corpus.py --verbose  # + reported cause vs ground truth
python3 scripts/guard_fp_corpus.py --compare  # live guard vs develop-tracked
```

Every case is a **string** passed to the guard's own `classify()`. The harness
opens no credential, spawns no shell, makes no network call. It calls the
subject's decision function rather than re-implementing its regexes, so it
measures the guard and not a model of the guard.

---

## 0. READ THIS BEFORE BRANCHING THE FIX

The enforced guard is the **promoted** copy at `.guard/`, generated from
`scripts/hooks/` by `scripts/promote-guard.py`. `.guard/` is gitignored by
design (derived artefact), so tracked and live can diverge. **They diverge now.**

| | |
|---|---|
| live `.guard/` promoted from | `e571e673`, 2026-08-12 |
| is `e571e673` in develop? | **no** |
| branches containing it | `sec/2cb1ed6e-quote-shield-splitter`, `eng/0cadfd51-delivery-outcome` |
| live file vs its manifest sha256 | **matches** (no tampering or hand-edit) |

The card 2cb1ed6e quote-shield fix is live but **not merged to develop**. Measured
against the develop-tracked copy, 6 of 7 credential-read shapes that the live
guard blocks are **allowed**, including the card's own example `echo "$(cat <dotenv>)"`.
The single unquoted control blocks on both, which is what proves the comparison
reached both modules rather than mis-loading one.

**Consequence for 779416f2:** a fix branched from `develop` would be written on
top of the vulnerable splitter and would silently revert 2cb1ed6e on promotion.
Branch from `sec/2cb1ed6e-quote-shield-splitter`, or land that branch first.
This is escalated separately to marveen as a process finding; it is not part of
779416f2's own scope.

---

## 1. Measured false positives (live guard)

Four benign shapes block. All four report `interpreter-env-read` or
`env-file-print`, i.e. a **secret-exfiltration** cause, while opening no file.

| id | shape | reported cause | ground truth |
|----|-------|----------------|--------------|
| A2 | apostrophe in a **comment** inside a python heredoc | interpreter-env-read | prints a constant |
| A5 | rackham's real blocked probe, 2026-08-14 | interpreter-env-read | loads a script, draws to /tmp |
| B2 | apostrophe in a trailing **shell comment** (`ls  # dave's dir`) | interpreter-env-read | lists a directory |
| D4 | `cat <dotenv>.example` | env-file-print | non-secret checked-in template |

### The precise mechanism (A2, A5, B2)

`match_interpreter_env_read` fails closed **before** it checks whether the
command is an interpreter at all:

```python
tokens = _tokenize(command)
if tokens is _PARSE_FAIL:
    return True                                    # <-- fires here
if _command_word(tokens) not in _INTERPRETER_CMDS:  # <-- never reached
    return False
```

So `ls -la /tmp  # dave's scratch dir` is reported as *"Bash interpreter (-c/-e
inline code) opening a .env file"* — and **all three** clauses of that sentence
are false: not an interpreter, no `-c`/`-e`, no dotenv file.

The trigger is narrower than "apostrophes". It is an **unbalanced quote**:

- A3 (`print("it's fine")` in a heredoc) → **allows**, the apostrophe sits inside double quotes
- A4 (`"""Return dave's default."""`) → **allows**, balanced
- B1 / B3 (`echo "it's fine"`, `git commit -m "dave's note"`) → **allow**
- A2 / B2 (apostrophe in a **comment**, unquoted) → **block**

Comments are the live hazard because `_tokenize` calls `shlex.split(comments=False)`,
so `#` is not honoured and the apostrophe inside it stays syntactically open.

### The fix pattern already exists in this file

`match_env_file_print` (R2) already does targeted fail-closed — it blocks an
unparseable piece **only if that piece also contains a sensitive filename**:

```python
if tokens is _PARSE_FAIL:
    if _is_sensitive(piece):
        return True
    continue
```

`match_interpreter_env_read` (R2b) uses blanket fail-closed 60 lines below.
Aligning R2b with R2 removes all three parse-fail false positives without
loosening R2b on any shape that names a credential.

Honest trade-off: targeted fail-closed lets an *unparseable* command that hides
the filename (concatenation, variable indirection) through. That is already true
of R2 today, so this makes the two rules consistent rather than adding a new
weakness — but it is a real narrowing of blanket fail-closed and should be a
conscious choice, not a side effect. If blanket blocking is kept, the message
must stop naming a specific attack (card's FIX item 3).

---

## 2. Measured false negative

| id | shape | verdict |
|----|-------|---------|
| E4 | clean heredoc whose body reads the dotenv file | **allowed** |

Independently reproduces dave's FINDING 2. Kept in the corpus as the
forward-looking control: after the fix it must flip to BLOCK.

---

## 3. What did NOT reproduce

marveen's brief listed *escaped quotes / `$()`-in-double-quotes (chad's finding)*
as a family. **I could not reproduce a false cause from that shape** on the live
guard. C1–C3 and eleven further exploratory variants (backticks in double quotes,
process substitution, nested single quotes inside `$()`, escaped-JSON curl
bodies, line continuations, `jq`/`awk`/`git log` quoting) all pass cleanly.

The only parse-fail triggers I found are genuinely unbalanced quotes. Either
chad's case was measured against the **develop-tracked** guard, where the naive
`_CMD_SUBST_RE` pre-pass behaves differently, or it is a shape I did not
construct. Flagged rather than quietly dropped — **chad's exact command would
close this gap.**

---

## 4. Carve-out regression controls (F1–F8)

The localhost-curl token carve-out (card 2cb1ed6e) is intentional and narrow.
The 779416f2 fix changes tokenization, which is exactly what the carve-out rests
on, so these guard against collateral damage. All eight hold on the live guard:

- sanctioned loopback recipe allowed, `127.0.0.1` spelling too
- external host, mixed loopback+external, no-URL, piped-elsewhere, capture-then-POST: all blocked
- dotenv does **not** inherit the carve-out

`cat store/.dashboard-token` alone stays blocked; only the loopback-curl header
shape is exempt.

---

## 4b. Dotenv suffix boundary — D4 DECIDED (dave, 2026-08-14)

**Decision: candidate X — the allow anchors on the `.example` ENDING.** The G
rows are settled acceptance criteria and count in the headline. The measurement
that produced the decision is kept below, because the rejected alternative is
the one a later reader will reinvent.

Today `_ENV_FILE_RE = (?:^|/)\.env(?:\.[^/\s]+)?$` treats every suffix after
`.env` alike, so all eight block. Two candidate narrowings, measured as regexes
over the same filenames:

| filename | safe to read? | X: ends `.example` | Y: component after `.env` |
|---|---|---|---|
| `.env.example` | yes | allow | allow |
| `.env.local` | **no** | block | block |
| `.env.production` | **no** | block | block |
| `.env.example.bak` | **no** | block | **allow — leak** |
| `.env.local.example` | yes | allow | block (over-narrow) |
| `config/.env.example` | yes | allow | allow |
| `.env` | **no** | block | block |
| `.env.sample` | yes | block (over-narrow) | block (over-narrow) |

**X leaks nothing; Y leaks `.env.example.bak`.** A `.bak` sitting beside a
template is at least as likely to be a copy of the real file, so the ending is
the load-bearing property — anchoring on the component right after `.env` reads
`example` there and lets it through. Both rules are wrong on `.env.sample`, but
in the safe direction.

**Second finding, independent of which rule is chosen.** The same file is
reachable through two different patterns: `_ENV_FILE_RE` (R2, shell print-verbs)
and `_OPEN_ENV_RE` (R2b, interpreter inline code). G1 and G2 are the same
`.env.example` file via `cat` and via `python3 -c`; G3 and G8 likewise for
`.env.local`. Narrowing only one leaves `cat <dotenv>.example` allowed while
`open('<dotenv>.example')` still blocks — the inconsistency an agent learns to
route around. Narrow both or neither.

`.env.sample` and `.env.template` are the same convention as `.example` and stay
blocked under the chosen rule. **Deliberately deferred** (dave): one narrowing
ships this round, because a "0 FP / 0 FN" acceptance criterion only means
something if no second axis moves underneath it. They live in the corpus as the
H family with `pending=True`; an H row still blocking after the fix is the
deferral working, not a regression.

---

## 5. Suggested acceptance for the fix

1. `python3 scripts/guard_fp_corpus.py` → **0 false positives, 0 false negatives**
   on the settled cases. Seven rows must flip to allow (A2, A5, B2 from the
   parse-fail fix; D4, G2, G6, G7 from the D4 narrowing) and E4 must flip to
   block. The three deferred H rows must still block — they are reported on
   their own line and do not count.
2. F1–F8 unchanged.
3. `--compare` → 0 gaps once 2cb1ed6e is in the base branch.
4. Both copies updated together, or `promote-guard.py` re-run, so `scripts/hooks/`
   and `.guard/` do not drift.

5. **Narrow both surfaces or neither.** The same file is reachable through
   `_ENV_FILE_RE` (R2, shell print-verbs) and `_OPEN_ENV_RE` (R2b, interpreter
   inline code) — D4 and G2 are one file via `cat` and via `python3 -c`.
   Narrowing one alone leaves the template allowed on one path and blocked on
   the other, which is the shape that teaches agents to route around the guard
   rather than what not to do. Dave took this into the fix scope.

---

## 6. What this corpus cannot see

A zero here is a **lower bound, not a proof**, and the bound is worth stating
because "0 false positives" reads like a guarantee:

- **38 shapes, not a population.** The corpus measures the command forms someone
  thought to write down. The A/B families were built backwards from four blocks
  that actually happened; nobody enumerated the space of unbalanced-quote
  commands. A shape absent from `CASES` is unmeasured, not safe.
- **The chad family is still UNKNOWN.** Escaped quotes and `$()` inside double
  quotes did not reproduce on the live guard across 14 attempts. Either it was
  measured against the develop-tracked copy, or it is a form I failed to
  construct. Absence of a reproduction is not absence of the defect.
- **One guard, one moment.** Every row is `classify()` on the live `.guard/`
  copy as promoted from `e571e673`. `--compare` shows the tracked copy already
  disagrees on three shapes; re-promotion moves the subject under the results.
- **Static strings only.** Nothing here executes, which is what makes the corpus
  safe to run — and also means it measures the *decision*, never whether a
  command that slips through would in fact open anything.

If the fix lands and the corpus reads 0/0, the honest claim is "none of the 38
measured shapes misfire", not "the guard has no false positives".
