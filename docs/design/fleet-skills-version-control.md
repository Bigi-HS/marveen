# Design: Fleet skills version-control + gate

**Card:** `2a6dc48d` ("Fleet skills version-control + gate (currently live-edited, no rollback)")
**Status:** DESIGN ONLY (no production code change in this branch)
**Priority:** low (hygiene)
**Author:** ephemeral eng sub-agent, 2026-06-15
**Base:** `develop` @ `b4f4b67`

---

## Problem

The fleet's operational skills live only at `~/.claude/skills/` on the host. They are
**not tracked by the repo**. Concretely:

- No git history on a SKILL.md edit -> no diff, no blame, no rollback.
- The merge-gate (pre-gate evidence bundle + PR + Thor/Dave review) is defined for
  *repo* changes and does not map onto editing a file that lives outside the repo.
  The current pragmatic substitute is "Thor reads the live SKILL.md path directly"
  -- a manual, un-versioned, un-auditable convention.
- The same edit can be made by multiple actors with no coordination. The card cites a
  real instance: `fleet-pr-merge-gate` took 3 live edits (Genesis) plus a v1.1 refactor
  (Dave) with **zero** version history, rollback, or audit trail.

This is the same class of problem as the gitignored `CLAUDE.md` (see `.gitignore:35-37`,
`CLAUDE.md` / `CLAUDE.md.bak-*`): a load-bearing, frequently-edited markdown artifact
that the product treats as personal/generated and therefore does not version.

## Current state (with file references)

### What IS tracked today
- `seed-skills/` -- **6 distribution-template skills** are in the repo:
  `ai-fleet-project-execution`, `channel-plugin-duplicate-socket`,
  `github-pr-rebase-merge`, `handoff`, `retrospective`, `skill-management`.
  Verified by `git ls-files seed-skills/`.
- `skills/skill-factory/SKILL.md` -- the self-learning meta-skill, tracked at repo root
  and installed separately by `install-linux.sh:812-817`.
- `scripts/skill-index.sh` -- regenerates the Level-0 index at
  `~/.claude/skills/.skill-index.md` from the LIVE dir (`scripts/skill-index.sh:6-7,25-44`).
- `scripts/skill-regression.sh` -- deterministic hygiene harness that scans the LIVE
  `~/.claude/skills` for the top-10 fleet skills (frontmatter, required sections,
  forbidden patterns like piped `jq` / bare `gh` / `requests`, bash+python fenced-block
  syntax). See `scripts/skill-regression.sh:21,29-40,181-281`. Writes
  `store/skill-regression-last.json` + `store/skill-regression-badge.json`.
- `scripts/install-skill-regression-cron.sh` -- registers the harness as a daily
  07:45 cron (`install-skill-regression-cron.sh:24` SCHEDULE, header lines 6-14).

### The seeding mechanism (Option A is partly built already)
`seed-skills/` is copied into `~/.claude/skills/` by the installers and `update.sh`,
with **copy-if-absent** semantics (never overwrites a live edit):

```
update.sh:218-232
  for skill_dir in "$SEED_SKILLS_DIR"/*/; do
    target="$SKILLS_DIR/$skill_name"
    if [ -d "$target" ]; then SEED_SKIP=...; continue; fi   # skip existing
    mkdir -p "$target"; cp "$f" "$target/..."               # else copy
  done
```

Same loop in `install-linux.sh:820-...` and `install-macos.sh:529-...`. Unit-tested in
`scripts/__tests__/seed-skills.test.sh` (Test 1 = copies new, Test 2 = skips existing /
preserves custom content, lines 20-90).

### The gap, quantified
The 6 tracked `seed-skills/` are install-distribution templates for a *fresh* deploy.
They have **zero overlap** with the 17 operational skills actually running live:

```
live ~/.claude/skills (17): adversarial-fixture-gate, c12-chameleon-test,
  design-critique, ephemeral-eng-workflow, fleet-audit, fleet-deploy-verify,
  fleet-meeting, fleet-ops, fleet-pr-merge-gate, pre-gate-evidence-bundle,
  quill-threat-model-stride, red-team, research-strategy, security-audit,
  spawn-fleet-subagent, unstick-wedged-agent, visual-validate-loop

tracked seed-skills (6): ai-fleet-project-execution, channel-plugin-duplicate-socket,
  github-pr-rebase-merge, handoff, retrospective, skill-management

intersection: {} (empty)
```

So every skill the fleet edits day-to-day -- including `fleet-pr-merge-gate`, the one
named in the card -- is untracked. The seeding plumbing exists; the *content* the card
cares about is not flowing through it.

### `store/` itself is gitignored (relevant precedent)
`.gitignore:8` ignores all of `store/`; `git ls-files store/` returns 0 tracked files.
This design doc had to be force-added (`git add -f`). The same gitignore-class issue that
hides skills also hides retros/design docs under `store/`. Worth noting as a sibling
problem, but **out of scope** here (this card is skills-only).

## Options

### Option A -- pull skills into an in-repo `seed-skills/` (versioned + real PR gate)

Promote the 17 live operational skills into the existing `seed-skills/` directory (or a
sibling `seed-skills-fleet/` if we want to keep install-templates separate from
operational ones). They become first-class repo files: full git history, diff, blame,
rollback, and the **existing** PR + Thor/Dave merge-gate applies unchanged because the
edit is now a normal tracked-file change.

**Tradeoffs**
- (+) Real version control + real gate with zero new gate machinery -- the change is
  "edit a repo file, open a PR". Pre-gate bundle, Thor review, and rollback (`git revert`)
  all work out of the box.
- (+) Reuses proven plumbing: the copy-if-absent seeding loop and its tests already exist
  (`update.sh:218-232`, `seed-skills.test.sh`).
- (-) Adds a **two-place reality**: repo copy vs live copy. Needs an explicit sync/deploy
  step to land merged changes onto `~/.claude/skills/`. The existing copy-if-absent loop
  will **NOT** update an already-present live skill (it `continue`s on existing dirs,
  `update.sh:222-224`), so on its own it never propagates an edit.
- (-) Live-editing friction: today an agent can edit a SKILL.md in place and it takes
  effect immediately. Under Option A that live edit is now untracked drift relative to the
  repo, exactly the problem we are trying to kill -- so we must either (a) discourage live
  edits and route all changes through PRs, or (b) provide a "promote live -> repo" capture
  step. Both are process changes, not just code.

#### Sync/deploy mechanics for Option A
The deploy must be **deliberate, idempotent, and drift-aware** (mirrors
`fleet-deploy-verify` discipline: deploy != merge, Genesis-GO required).

1. **Source of truth = repo.** After a skills PR merges to `develop`, deploy is a
   separate step (like the dashboard build/restart in `fleet-deploy-verify`).
2. **Sync script** `scripts/deploy-skills.sh` (new), idempotent, with three modes:
   - default (`--check`): for each repo skill, `diff` against the live copy; print
     ADD / UPDATE / IN-SYNC / LIVE-AHEAD per skill. No writes.
   - `--apply`: copy repo -> live for ADD and UPDATE skills, after taking a timestamped
     backup of the live dir (reuse the `backups/` convention, `.gitignore:` has
     `backups/`). This is the line that the existing copy-if-absent loop deliberately
     does NOT do, so it must be a distinct, gated path.
   - `--promote <skill>`: copy a live edit back into the repo working tree so it can be
     committed via PR (the "capture a hotfix" path). This is how a legitimate live edit
     re-enters version control instead of becoming silent drift.
3. **LIVE-AHEAD guard.** Before `--apply` overwrites a live skill, if the live copy
   differs from BOTH the old and new repo copy (i.e. someone live-edited it), STOP and
   require `--promote` first or an explicit `--force`. This prevents the deploy from
   silently discarding an un-captured live edit -- the exact failure mode that bit the
   token-discard incident (memory: "drift-discard bug threw away fresh tokens").
4. **Re-index after apply:** run `scripts/skill-index.sh` so `.skill-index.md` reflects
   the new set.
5. **Regression gate after apply:** run `scripts/skill-regression.sh`; a BLOCK verdict
   (exit 1) fails the deploy. This wires the existing harness into the deploy path.
6. **Ownership:** Genesis runs deploy transitionally; Forge/Armorer owns it once live
   (same handoff as `fleet-deploy-verify`).

### Option B -- lightweight separate git-track of `~/.claude/skills` + "read-the-diff" gate

Make `~/.claude/skills/` its own small git repo (or a sparse second worktree of this
repo pointed at a `fleet-skills` branch). Skills are edited live as today; git just
*records* the history in place. The gate becomes a convention: before accepting a skill
change, Thor reads `git -C ~/.claude/skills diff` instead of reading the raw SKILL.md.

**Tradeoffs**
- (+) Zero sync/deploy step -- the tracked dir **is** the live dir, so live edits and
  history are the same place. No two-place reality.
- (+) Minimal upfront work: `git init` + `.gitignore` for the index + a commit habit.
- (+) Preserves the immediate-effect live-edit ergonomics agents rely on.
- (-) Not integrated with the product repo: a skill change can't ride the existing PR
  pipeline, pre-gate bundle, or Thor/Dave merge-gate machinery. The "gate" is a manual
  read-the-diff convention with no enforcement -- essentially formalizing today's
  workaround, not replacing it.
- (-) A second repo/remote to provision, back up, and keep alive (another thing that can
  silently rot -- cf. the watchdog/keep-alive burden across the fleet).
- (-) Discipline-dependent: nothing forces a commit, so history has gaps unless every
  agent commits after every edit. No CI/regression gate unless we also wire the harness
  to a commit hook.
- (-) Rollback is per-skill `git checkout`, which is fine, but there is no cross-review
  before a change goes live (it's already live by the time anyone reads the diff).

### Audit / rollback comparison

| Capability            | Option A (in-repo seed)                      | Option B (track live dir)              |
|-----------------------|----------------------------------------------|----------------------------------------|
| Git history           | Yes, in product repo                         | Yes, in a separate repo                |
| Diff before it's live | Yes (PR review pre-merge)                     | No (already live; diff is post-hoc)    |
| Enforced gate         | Yes (existing Thor/Dave + pre-gate bundle)   | No (manual read-the-diff convention)   |
| Rollback              | `git revert` + deploy                         | `git -C ~/.claude/skills checkout`     |
| Audit trail           | PR + commit + reviewer in product repo        | commits only, no review record         |
| Sync/deploy step      | Required (the cost)                          | None                                   |
| Live-edit ergonomics  | Friction (must promote or PR)                | Unchanged                              |

## Recommendation

**Adopt Option A, scoped and incremental, with one Option-B ergonomic borrowed in.**

Rationale:
- The card's pain is specifically *no version history / no rollback / no real gate* on
  changes to the fleet's own skills. Only Option A gives an **enforced, pre-merge** gate
  using machinery that already exists; Option B only formalizes the manual workaround.
- The plumbing for A is ~60% built (`seed-skills/`, copy-if-absent loop + tests,
  `skill-index.sh`, `skill-regression.sh`). The missing piece is an *update*-capable,
  drift-aware deploy script and the one-time content migration of the 17 live skills.
- The single real downside of A -- losing immediate live-edit effect -- is mitigated by
  the `--promote` capture path (borrowed from B's "edit in place" ergonomic): an agent
  may still hotfix live, then `--promote` re-enters it into version control via a PR.

Scope it as two phases so the low-urgency hygiene work stays small:

- **Phase 1 (the version-control win):** migrate the 17 live skills into a tracked dir
  (`seed-skills-fleet/`, keeping `seed-skills/` as install-distribution). One PR, content
  only. From this PR forward, skill changes go through normal PRs. This alone closes the
  "no history / no gate" gap.
- **Phase 2 (the deploy ergonomics):** add `scripts/deploy-skills.sh` (`--check`,
  `--apply`, `--promote`) with the LIVE-AHEAD guard, wire `skill-index.sh` +
  `skill-regression.sh` into `--apply`, and document it in `fleet-deploy-verify`.

Keep `seed-skills/` (the 6 install templates) and `skill-factory` exactly as they are;
do not entangle install-time seeding with operational deploy.

## Acceptance criteria (for the eventual build)

Phase 1:
1. All 17 current operational skills are tracked in the repo under a dedicated dir
   (proposed `seed-skills-fleet/`), each as `<skill>/SKILL.md` (+ any `scripts/`/
   `references/` it has). `git ls-files` lists them.
2. The 6 existing `seed-skills/` install templates and `skills/skill-factory` are
   unchanged (`git diff` touches neither).
3. A short README or note in the new dir documents: source of truth = repo, changes via
   PR, hotfix via `--promote`.
4. No secrets/tokens land in any tracked SKILL.md (Chad scan clean -- skills can quote
   token *paths* like `store/.dashboard-token` but never values; this matches the
   `security-audit` skill's own example usage).

Phase 2:
5. `scripts/deploy-skills.sh --check` reports per-skill ADD/UPDATE/IN-SYNC/LIVE-AHEAD and
   makes no writes.
6. `--apply` is idempotent (second run = all IN-SYNC, no changes), takes a timestamped
   live backup before writing, and refuses to overwrite a LIVE-AHEAD skill without
   `--promote`/`--force`.
7. `--promote <skill>` copies the live edit into the repo working tree only (no commit,
   no push) so it can go through the normal PR gate.
8. `--apply` runs `skill-index.sh` and `skill-regression.sh`; a regression BLOCK
   (exit 1) fails the deploy non-zero.
9. Unit tests in `scripts/__tests__/` cover: ADD copies, UPDATE overwrites, IN-SYNC
   no-op, LIVE-AHEAD guard blocks, `--promote` round-trip -- using a temp dir harness
   (no live `~/.claude/skills` writes), in the style of `seed-skills.test.sh`.
10. `fleet-deploy-verify` skill documents the skills deploy as a Genesis-GO step.

## Risks / open questions

- **Two-place drift is the core risk of A.** The LIVE-AHEAD guard (AC6) is the primary
  control; without it, `--apply` can silently discard an un-captured live edit. This
  must be a hard guard, not a warning. (Precedent: the OAuth token-discard incident.)
- **Migration churn.** Phase 1 copies 17 dirs into the repo; the diff is large but is
  pure addition (no deletions) -- reviewers should confirm the diff is add-only, like the
  worktree base-pin gotcha check in `ephemeral-eng-workflow`.
- **Where to put them: `seed-skills/` vs new `seed-skills-fleet/`?** Recommendation:
  separate dir, because the install-time copy-if-absent loop (`update.sh:218-232`) would
  otherwise auto-seed all 17 fleet skills onto every fresh install, which may not be
  desired for a generic distribution. Open for Boss/Genesis call.
- **Does the regression harness's TOP10 list (`skill-regression.sh:29-40`) need to grow
  to cover the full 17 once they're tracked?** Probably yes, but that's a follow-on, not
  a blocker.
- **`store/` gitignore sibling problem.** Retros/design docs under `store/` are equally
  untracked (this doc was force-added). Out of scope here; flag separately if the fleet
  wants design docs versioned too.
- **Who edits skills going forward?** If multiple agents keep live-editing, Phase 1's
  value erodes unless the PR-first norm is actually adopted. This is a process commitment,
  not just code. Low-urgency, so adoption can be gradual, but the recommendation assumes
  it.
