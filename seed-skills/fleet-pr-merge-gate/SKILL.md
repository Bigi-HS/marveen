---
name: fleet-pr-merge-gate
description: >-
  Open and merge a Genesis-fleet PR through the Thor+Dave merge-gate using the GitHub REST
  API (no gh CLI). Load when you need to push a feature/fix branch, open a PR to develop,
  get Thor's review, merge with a proper "merged" badge, rebase a stacked PR after its
  dependency lands, or do a develop->main release. Covers the PAT, mergeable polling, the
  ff-vs-API-merge gotcha, the MANDATORY mechanical gate check (card fa11eb63), and branch cleanup.
---

# Fleet PR + Thor+Dave merge-gate

This host has **no `gh` CLI**, no `jq`. Drive GitHub via `python3 urllib`. Repo: `Bigi-HS/marveen`.
PAT lives in `~/.git-credentials` (`https://USER:TOKEN@github.com`) -- extract with regex, NEVER
print it. Integration branch is **develop**; releases go develop->main. Every change merges ONLY on
BOTH Dave's and Thor's green (the merge-gate). Live/main/deploy needs Genesis-GO.

**The gate is now MECHANICALLY ENFORCED (card fa11eb63).** Posting an APPROVE/BLOCK as a PR comment is
the human half; the binding half is a `gate_approvals` record in claudeclaw.db, checked by the server
before any merge. The merge step below MUST call `GET /api/gate/check` and refuse to merge unless it
returns `pass:true` on the CURRENT head.sha. This exists because of PR #206: a security PR merged with
Chad PASS present but Dave eng sign-off absent (the gate was a social convention any PAT holder could
skip). See "Mechanical gate enforcement" below -- it is not optional.

## Procedure

1. **Branch off develop**, code, test. `git checkout develop && git reset --hard origin/develop`
   then `git checkout -b feat/<name>`. Build + full suite green before pushing (only the 4
   pre-existing managed-settings WSL failures are acceptable). For any lifecycle/launch/monitor/model
   change, run the c12 sandbox first (see [[c12-chameleon-test]]).
2. **Push**: `git push -u origin feat/<name>`.
3. **Open the PR** to develop via the API (see scripts/pr.py pattern below).
4. **Request Thor's review** via inter-agent (`to:"thor"`): link the PR, name the changed files, state
   the safety claim to verify, suggest attack surfaces, give repro commands. Hold -- do NOT merge.
5. **Address Thor's findings**: fix (often test-only), push; card non-blockers as follow-ups. Re-confirm
   with Thor if you changed more than the pre-approved one-liner.
6. **Record verdicts, then merge through the mechanical gate.** Each reviewer (Thor, Dave, and Chad on a
   security PR) records their verdict with `POST /api/gate/approve` on the head.sha they reviewed, in
   ADDITION to the PR comment. Merge ONLY via the enforced flow in "Mechanical gate enforcement" below
   (gate check must `pass:true` on the live head.sha) with API `merge_method:"merge"` so the badge reads
   "merged". Poll `mergeable` first (it is `null` right after the base moves).
7. **Sync + cleanup**: `git checkout develop && git reset --hard origin/develop`; delete the branch
   local + remote.
8. **Signal deploy-ready** to Genesis; the deploy (build + marveen dashboard restart + 4-point verify)
   is Forge's once live, else Dave's transitionally, ALWAYS under Genesis-GO. See [[forge-devops-release-agent]].

## Mechanical gate enforcement (card fa11eb63) -- MANDATORY before any merge

The dashboard server (localhost:3420) holds the gate state. Reviewers WRITE verdicts; the merge step
READS the check and refuses on a fail. Token: `store/.dashboard-token` (Bearer). All endpoints are
`/api/gate/*`.

**Advisory boundary (MG-SEC4).** The `reviewer` identity is caller-supplied under the shared Bearer
token; `recorded_by` captures the calling agent for audit but is NOT cryptographically authenticated.
This gate prevents ACCIDENTAL merge-before-approval (the #206 class); it does NOT stop an adversarial
agent from self-approving as all three reviewers. Hard fix = per-agent auth tokens (card 8dac7f1d).
The ONE hard enforcement is the head.sha re-verify at merge time: approvals are always evaluated
against the live GitHub head.sha, so any new commit silently invalidates every prior approval.

**Record a verdict** (each reviewer, on the sha they reviewed):
```python
import urllib.request, json
DASH = "http://localhost:3420"
GTOK = open("/home/domin/marveen/store/.dashboard-token").read().strip()
def gate(method, path, body=None):
    req = urllib.request.Request(DASH + path, data=json.dumps(body).encode() if body else None,
        headers={"Authorization": "Bearer " + GTOK, "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            b = r.read().decode(); return r.status, (json.loads(b) if b else {})
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

# reviewer in {'thor','dave','chad'}, verdict in {'approved','blocked'}; head_sha = the 40-char sha reviewed
gate("POST", "/api/gate/approve",
     {"pr_number": N, "head_sha": HEAD, "reviewer": "dave", "verdict": "approved", "recorded_by": "dave"})
```
A `blocked` verdict is PERMANENT for that sha (sticky): a later `approved` on the same (pr, sha, reviewer)
does NOT clear it -- only a NEW commit (new sha) starts a clean slate.

**Enforced merge** (replaces a bare `PUT /pulls/N/merge`). Uses the `api()` helper from the GitHub
snippet below:
```python
# 1. LIVE head.sha from GitHub (not a value cached earlier this session).
_, pr = api("GET", f"/pulls/{N}"); head = pr["head"]["sha"]
# 2. Gate check (server independently re-fetches head.sha + detects security paths).
_, chk = gate("GET", f"/api/gate/check?pr={N}")
# 3. MG-AC6 TOCTOU guard: the sha the gate evaluated MUST equal the live head.
if chk["head_sha"] != head:
    raise SystemExit("sha mismatch -- PR got a new commit between fetch and check; re-run gate")
# 4. Refuse on any fail (missing reviewer or a blocked verdict).
if not chk["pass"]:
    raise SystemExit(f"GATE NOT CLEAR. required={chk['required']} missing={chk['missing']} blocked={chk['blocked']}")
# 5. Merge WITH the sha guard (MG-AC6 last-mile -- GitHub rejects if head moved).
s, res = api("PUT", f"/pulls/{N}/merge", {"merge_method": "merge", "sha": head, "commit_title": f"Merge PR #{N}"})
if not (s == 200 and res.get("merged")):
    raise SystemExit(f"merge failed {s}: {res}")   # an override, if used, stays active for a retry
# 6. On SUCCESS only: consume an override if one cleared the gate (idempotent; 404 if none).
if chk.get("override_active"):
    gate("POST", "/api/gate/consume-override", {"pr_number": N, "head_sha": head})
```

**Override (Boss-level emergency bypass only).** When Boss authorizes a merge despite a missing/blocked
reviewer (e.g. production-down hotfix), `POST /api/gate/override {"pr_number":N,"head_sha":HEAD,
"reason":"..."}` -> the next gate check returns `pass:true, override_active:true`. The override is
sha-locked + single-use; the enforced-merge flow consumes it after a successful merge. Never self-issue
an override for routine convenience -- it is logged with `recorded_by` and a mandatory reason.

## Author recusal (card 46de122b)

A reviewer cannot approve their OWN PR (MG-SEC5 self-approval block), so hard-requiring a
reviewer who authored the PR deadlocks the merge (PR#417: `required=[thor,dave]`,
author=dave, the `dave` seat is unfillable -> 403 forever). The gate now **auto-recuses** a
reviewer-author: when the trusted author record says the PR's author is a gate reviewer,
that reviewer is dropped from `required` and the backup seat `chad` is promoted (e.g.
dave-authored non-security PR -> `required=[thor,chad]`). A security PR authored by chad is
the one exception: chad stays required (it is the sole security seat) so the gate blocks
until an operator relay records a real security approval -- recusal never lets a security PR
pass without security review. The gate result carries `author` + `recused` so the decision
is auditable.

Recusal only engages when authorship is **recorded** in `gate_pr_authors`, and that record
must carry the AUTHORING AGENT's identity. It is written on the identity-bound proxy
`POST /api/github/pr` from `identity.agentId`. **Gap (Part A, follow-up):** opening a PR via
the direct GitHub REST `POST /pulls` (the snippet below) records NO author; opening via the
proxy with the shared admin token records the OPERATOR (`marveen`), not you -- both leave
recusal inert (fail-safe: no record -> today's behavior, the operator relay below still
works). Wiring per-agent-identity PR-open so `dave`-authored PRs record `dave` is the
remaining step to make recusal fire automatically. Until then, the operator-relay fallback
(NoA records the recused seat, or a Boss override) remains the path for author-recused PRs.

## API snippets (python3 urllib)

```python
import re, json, os, time, urllib.request, urllib.error  # urllib.error needed for the HTTPError catch below
TOKEN = re.search(r"https://[^:]+:([^@]+)@github\.com", open(os.path.expanduser("~/.git-credentials")).read()).group(1)
H = {"Authorization":"token "+TOKEN, "Accept":"application/vnd.github+json", "User-Agent":"dave", "Content-Type":"application/json"}
def api(method, path, body=None):
    req = urllib.request.Request("https://api.github.com/repos/Bigi-HS/marveen"+path,
        data=json.dumps(body).encode() if body else None, headers=H, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            b = r.read().decode(); return r.status, (json.loads(b) if b else {})  # 204 (DELETE branch) has empty body -> json.load crashes
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read().decode() or "{}")

# open PR:   api("POST","/pulls",{"title":..., "head":"feat/x", "base":"develop", "body":...})
# merge: use the ENFORCED flow in "Mechanical gate enforcement" above, NOT a bare PUT /pulls/N/merge.
```

## Dependencies / environment

This skill ships **no executable tool** -- the `api()`/`gate()` helpers above are snippets you define per
session, not pre-installed binaries. They ride only the Python **stdlib** (`urllib.request` +
`urllib.error`, `re`, `json`, `os`, `time`); do NOT reach for `requests` (not guaranteed installed)
and there is **no `gh`/`jq`** on this host. The credential extraction is brittle by design and
assumes `~/.git-credentials` holds a line in the exact form `https://USER:TOKEN@github.com` -- if
that file is missing, empty, or in another format the `re.search(...).group(1)` raises, which is the
intended fail-fast (better than a silent unauthenticated call). Never echo the captured TOKEN. The gate
endpoints need the dashboard server up at localhost:3420; if it is down, the merge MUST NOT proceed
(the enforced flow raises on the failed check rather than falling back to a bare merge). If the host
ever gains `gh`/`jq` or the credential store moves, update this section and the snippet.

## Don't merge while an author fix is in flight

When a gate verdict flags a LOW/INFO as "fix incoming" or "deploy-prereq, author will patch", the
author may be pushing a fix commit to the SAME branch concurrently. If you merge + delete the branch
before that commit lands, the fix is **orphaned** (commit safe by SHA, but not on develop) and the
merged code keeps the flagged state. Seen 2026-06-10: merged #111 at `fafea2b` on Thor's
"merge-ready" while Dave pushed `a305120` (securityProfile fix) to the branch -> orphaned, develop
kept `worker-local`; required follow-up PR #112 to re-land. **Before merging, ask the author "is
anything still in flight on this branch?" or confirm `GET /pulls/N` `head.sha` matches the commit you
reviewed.** The mechanical gate now backs this: a new commit changes head.sha, which invalidates every
prior approval, so an in-flight push makes the gate check fail closed rather than merging stale.
Recovery if it happens: the orphaned commit is reachable by SHA -- cherry-pick or re-apply
its diff churn-safe via the Contents API onto a fresh branch off develop, new PR, re-gate (same diff),
merge.

**Cache-lag caveat (why head.sha alone isn't enough):** after a push, GitHub's API can keep
returning the OLD `head.sha` for a few minutes (cache lag) -- on 2026-06-10 `GET /pulls/111` still
reported `fafea2b` for minutes after Dave pushed `a305120`, so the merge took the stale tip. So
don't just read head.sha once: if you know a commit was just pushed, POLL `GET /pulls/N` head.sha
until it equals the SHA you expect (or until it stops changing across two reads), or confirm with the
author that nothing is pending, BEFORE issuing the merge.
The same lag bites AFTER merge: a merged PR's `GET /pulls/N` can still report a PRE-fix `head.sha`
(e.g. a late price-fix commit invisible), making it look like the wrong tip merged. Don't raise a
false alarm off head.sha -- confirm what actually landed by reading the file on the base branch:
`GET /contents/<path>?ref=develop` (base64-decode `content`). Confirmed 2026-06-16: #176 showed
`head=27160ed` (pre-fix) while develop already held the corrected commit. Also note: the PR *list*
endpoint (`/pulls?state=open`) omits the `mergeable` field -- only the per-PR `GET /pulls/N` has it.

## Stacked PRs

If PR-B depends on PR-A (same file region), base PR-B on PR-A's branch. After PR-A merges to develop:
`git checkout B && git rebase develop` (the dependency commit drops as already-applied), build+suite,
`git push --force-with-lease`, then `PATCH /pulls/B {"base":"develop"}`, poll mergeable, merge.

**CRITICAL ORDER -- retarget PR-B BEFORE merging PR-A.** Merging PR-A auto-deletes its branch, and
since that branch is PR-B's `base`, deleting it **CLOSES PR-B** (base gone). A PR closed by a deleted
base **cannot be reopened** -- you must open a fresh PR. So either (a) `PATCH /pulls/B {"base":"develop"}`
FIRST, then merge PR-A; or (b) accept PR-B will close and recover: rebase B's head onto develop
(`git rebase develop` -- A's commits drop as upstream), `git push --force-with-lease`, then open a
**fresh** PR B'->develop. The gate APPROVE carries over if the rebased tree/diff is byte-identical to
the approved commit (rebase only changes the parent) -- ask the reviewer for a 1-line re-confirm on the
new head for a clean audit trail, no full re-review. Note the rebase changes head.sha, so the
mechanical gate needs fresh `POST /api/gate/approve` records on the new sha before merge. Seen
2026-06-14: merged #136 (base of #139) -> #139 auto-closed -> recovered as fresh #140 (Thor 1-line
re-confirm, merged).

## develop -> main release

Pure fast-forward when main is behind and 0-ahead: `git merge-base --is-ancestor origin/main
origin/develop` -> if YES, `git push origin develop:main`. Verify `origin/main` advanced and contains
the develop tip. No PR needed for a clean ff release.

## Buktatók
- **Packaging live-only uncommitted edits = check your base FIRST.** When you version changes that
  already run live in the main working tree (not freshly coded on a clean branch), your local checkout
  may sit on a STALE base while origin/develop moved ahead. Committing the tracked files as-is can
  silently REVERT a feature that landed upstream after your base. Confirmed 2026-06-12: local
  fleet-supervisor.sh was pre-#125 and would have clobbered the `ensure_tailscaled` reboot-persistence
  block. Fix: `git fetch origin develop`; `git diff origin/develop -- <files>` and READ it (extra
  deletions = stale base); `git checkout origin/develop -- <tracked-files>` to reset them, `git checkout
  -B <branch> origin/develop`, then RE-APPLY only your intended change surgically (an untracked new file
  survives the checkout). Verify the staged diff is EXACTLY your intent before committing.
- **Local `develop` LAGS origin after an API merge -- ff it before branching/reverting off it.** API
  merges (PUT /pulls/N/merge) advance `origin/develop` but NEVER touch your local `develop` ref. So right
  after you merge a PR, `git checkout -b <b> develop` branches off the STALE pre-merge tip, and `git revert
  -m 1 <merge-sha>` against it no-ops / produces an empty diff (the merge isn't in that history). Confirmed
  2026-06-17: a revert of #206 branched off stale local develop (378b028, pre-merge) instead of
  origin/develop (2d22a99) -> empty revert, wasted branch+push. Fix: before any branch/revert off develop,
  `git fetch origin develop && git merge --ff-only origin/develop` (or branch off `origin/develop`
  explicitly). Verify `git rev-parse develop == origin/develop` and that the revert diff actually removes
  the intended files (`delete mode ...`) before pushing. (NB: `git ls-tree <branch> <path>` exits 0 even
  when the path is absent -- use the diff `delete mode` line, not ls-tree exit code, to confirm removal.)
- **ff-push closes a PR as "closed", NOT "merged"**: fast-forwarding develop to a branch tip (then
  force-pushing the branch) records no merge event. Use the API `merge` button instead for the badge.
- `mergeable` is `null` (unknown) right after the base moves -- GitHub recomputes async; poll until
  true/false before merging.
- PAT: extract via regex, never echo it; pushes use the stored credential helper automatically.

## Concurrent-agent branch churn

Other fleet agents (Forge, Chad, Kalapács, ...) now run git in the SAME working tree/repo, so the
checked-out HEAD branch can SWITCH under you between tool calls. The whole-repo failure mode is: you
commit, but the branch ref has drifted, so your commit lands on someone else's branch (or a push
ships a stale ref -> "No commits between develop and mybranch"). The commit object itself is always
safe by its SHA -- these defences keep it on YOUR branch instead of forcing a recovery.

- **Commit before you switch/sync branches.** `git reset --hard origin/develop` (or `git checkout
  <branch>`) with uncommitted edits in the working tree WIPES them silently -- this cost a full
  re-implementation once (item4: the code edits were lost, only the new untracked test file survived,
  producing a commit with the test but not the code). Always `git add` + `git commit` your work FIRST,
  then branch/sync. After any commit, verify the code is really in it: `git show HEAD:<file> | grep
  <new-symbol>` and `git show --stat HEAD`.
- **The HEAD branch can drift between tool calls.** Seen: a commit landed on
  `feat/forge-observability-baseline`/`feat/aidefence-guard` instead of my branch. Defences:
  (1) `git branch --show-current` IMMEDIATELY before `git commit`; (2) push to an EXPLICIT ref:
  `git push origin HEAD:<your-branch>` (ships the actual HEAD, not whatever local branch ref drifted);
  (3) recover a stranded commit with `git push origin <sha>:<your-branch>`. A clean single-commit
  feature branch off develop usually fast-forwards, so no `--force` is needed.
- **Churn-safe single-file fix on a PR branch via the Contents API.** When you must apply a small
  gate-finding fix to a PR branch but the shared working tree has churned to ANOTHER agent's branch
  (`git branch --show-current` != your target -> editing locally would touch the wrong tree), skip
  local git entirely: `GET /contents/<path>?ref=<branch>` -> base64-decode `content`, `assert old in
  content` (abort if the expected text is gone -> the file moved under you), `str.replace`, then `PUT
  /contents/<path> {message, content:b64, sha, branch}`. Commits straight onto the PR branch, no
  checkout, churn-immune. Confirmed 2026-06-10 fixing PR #100's commit-policy line while the tree sat
  on Kalapács's branch. Then ping the reviewer to re-review -> APPROVE -> merge.
- **Working-tree reversion flake.** On this host the harness/linter sometimes shows stale (pre-change)
  file snapshots in system notes after a branch switch. The COMMITTED/pushed state is authoritative --
  verify with `git show HEAD:<file>` and `git diff develop`. Only `git reset --hard HEAD` (NOT
  origin/<branch>) to resync, and only once you've confirmed everything you want is committed.
- **Clean leaked files after a checkout.** Don't let a stacked/other branch's changes leak into the
  wrong branch: after `git checkout`, run `git status` and `git checkout develop -- <leaked-files>`
  to clean before committing.

## Reviewing ANOTHER agent's PR as the Dave gate-half

Genesis routes other agents' PRs (Forge, Chad, Kalapács, ...) to you for the Dave review. Review the
DIFF, judge it on merits (don't rubber-stamp), and reply approve/BLOCK per PR with file:line specifics.
Record the verdict mechanically too: `POST /api/gate/approve` with `reviewer:"dave"` on the head.sha you
reviewed (a BLOCK = `verdict:"blocked"`, which is sticky for that sha).
- Fetch the diff read-only via the API (no local checkout -> safe in the shared/churned repo):
  `GET /pulls/N` (mergeable, changed_files) and `GET /pulls/N/files` (per-file `patch`).
- Assess: correctness + the integration point (e.g. where a guard is wired), security surface, scope.
- **Catch cross-contamination** (the concurrent-branch-churn failure): two PRs that both `add` the same
  new file will conflict on the second merge; a PR carrying another agent's files or an already-merged
  change is wrong-scope -> BLOCK with the untangle plan (each PR = only its scope; drop already-merged
  dupes). Verify the post-merge `develop` matches your verdict: `git ls-tree -r origin/develop` (exactly
  one of the new file), and read the merge-commit titles for the gate honored (e.g. "Chad+Thor+Dave" on a
  security PR).
- Security/credential/auth PRs need **Thor + Dave + Chad** (Chad runs `security-audit`); plain PRs Thor+Dave.
  The mechanical gate enforces this automatically: a diff touching a security-sensitive path adds `chad`
  to the `required` list, so the check fails until Chad records an approval (MG-AC4).
- Don't claim credit for an untangle/merge you didn't perform -- verify the result instead and say who did it.
- A stale scheduled task pointing at already-done cards: verify status, SKIP (don't redo), flag the task
  for cleanup; don't ping a sleeping user for a no-op (report to Genesis).
- **Never trust a green run in the shared main checkout** (`/home/domin/marveen`). Untracked required files
  sitting in its working tree make a test suite FALSE-GREEN (passes only because the loose file happens to
  be present; a clean checkout is inert and the tests fail). Verify a gate fix on a CLEAN detached worktree
  at the pushed tip: `git worktree add --detach /tmp/wt <sha> && cd /tmp/wt && <run tests>` -> only that
  proves real-green. Confirmed 06-10 on PR #113 (Dave BLOCK: prompt-template+schema untracked).
- **The main checkout is the LIVE SERVER's -- keep it on `develop`, never code/commit in it.** Building a
  feature there leaves files untracked AND parks the live checkout on a feature branch (08:00-rebuild hazard).
  Do all coding in an isolated `marveen-wt/` worktree ([[worktree-isolation-vs-branch-churn]]). If you must
  touch the main checkout while another agent may be active in it, expect branch-churn under you (06-10 #113:
  two agents committed into it concurrently, a near-miss) -- check `git rev-parse HEAD` before/after.

## Skill-update triggers

- **GitHub API changes** (new merge strategies, new status checks): Update API snippet section and procedure
- **Repository URL / PAT location changes** (~/.git-credentials → different location/format): Update credential extraction code
- **Gate policy evolves** (new review roles, new merge requirements, gate endpoints change): Update Procedure, the "Mechanical gate enforcement" section, and gate descriptions
- **Tool availability changes** (gh CLI installed? jq becomes available?): Update opening disclaimer
- **Concurrent-agent safety rules evolve**: Document new defensive patterns

**Skill maintainer**: Dave (owner). Version: fleet-pr-merge-gate v1.2 (live). Last updated: 2026-06-17.
v1.2 (card fa11eb63): added the MANDATORY "Mechanical gate enforcement" section -- reviewers write
`POST /api/gate/approve` verdicts, the merge step calls `GET /api/gate/check` and refuses unless
`pass:true` on the live head.sha, with the head.sha re-verify + `sha` merge-guard (MG-AC6) and the
override consume lifecycle (MG-AC7). Structural prevention of the #206 incident. Also version-controlled
this skill under seed-skills/ for the first time; DEPLOY ORDER: copy this file to the live skill dir
ONLY AFTER the dashboard server carrying /api/gate/* is restarted, else every merge would call a
non-existent endpoint and fail closed.
v1.1: Applegate grader P2/P3 clarity pass -- promoted the shared-repo churn bullets into a dedicated
"Concurrent-agent branch churn" section, added the "Dependencies / environment" note, made the
`urllib.error` import explicit in the snippet.

## Related skills

- [[security-audit]]: Chad runs on security/credential PRs (required reviewer) — mentioned in "Reviewing ANOTHER agent's PR" section
- [[pre-gate-evidence-bundle]]: Mechanical evidence (tsc, tests, diff-size) required before gate requests — complements this skill's gate workflow
- [[c12-chameleon-test]]: Safe sandbox for testing lifecycle/launch/monitor/model changes — linked in Procedure step 1
- [[fleet-ops]]: Inter-agent message routing (to:"thor" review request) — used in Procedure step 4

## Ellenőrzés
- PR opened: API returns the number + html_url.
- Gate clear: `GET /api/gate/check?pr=N` -> `pass:true` on the live head.sha (required reviewers all approved, none blocked).
- Merged: `PUT /pulls/N/merge` -> 200 `{"merged":true}`; `GET /branches/develop` tip advanced.
- After cleanup: `git log develop..HEAD` empty; branch gone local+remote.
