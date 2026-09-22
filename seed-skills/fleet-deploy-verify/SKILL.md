---
name: fleet-deploy-verify
description: >-
  Deploy the Genesis dashboard server (build + marveen tmux restart) and run the 4-point verify
  + MCP-pipe-recovery watch, with rollback. Load when activating merged develop code on the running
  server. WSL, no systemd. Every LIVE deploy needs Genesis-GO (Genesis from Boss). Forge owns this
  once live; Dave runs it transitionally.
---

# Fleet deploy + verify

**DEPLOY-HOLD SENTINEL CHECK -- the FIRST thing, before delta-enumeration or GO (confirmed 2026-09-15 near-miss).**
Before pushing/running any deploy on a develop tip, `ls store/.deploy-hold-*` and READ each sentinel. A hold
sentinel documents a deliberate block on shipping specific commits until named release-conditions are met
(e.g. `.deploy-hold-651`: fleet-wide SessionEnd hook must not activate without c12 sign-off + the flag-gate
PR merged). Check whether the tip you're about to deploy CONTAINS the held commit (`git merge-base --is-ancestor
<held-sha> <tip>`) AND whether every release-condition is satisfied. If a hold is active and unmet, STOP -- do
NOT deploy, even under a general GO. 2026-09-15: a heartbeat deploy-push targeted tip 79af9c4 (contained #651
ae2baae, held) and would have activated the fleet-wide SessionEnd hook without c12 + without the flag-gate;
Dave caught it. A held commit is often the ANCESTOR of later "safe" PRs, so those can't ship from a linear tip
without it -- the correct path is to first merge the gating PR (making the risky code present-but-inert), then
deploy. Genesis-GO authorizes the action, NOT the override of a hold-condition.

**PREMISE CHECK before any deploy -- even after a GO (confirmed 2026-07-20 codetree incident).**
A GO authorizes the action, not the diagnosis behind it. Before building/restarting, curl the REAL
endpoint the deploy supposedly fixes -- with its ACTUAL route path, not an assumed `/health` or bare
`/api/<feature>`. A 404 can mean the path never existed (wrong test), NOT a missing deploy: on 2026-07-20
I read `/api/codetree/health` + `/api/codetree` as 404 and concluded "codetree not deployed", but the
real paths (`/api/codetree/meta|symbol|rebuild`) returned 200 with a fresh index -- the feature was
fully live and the deploy would have been pure risk (an unrelated PR backlog + Telegram-pipe hazard for
zero benefit). Grep the route file for the exact `path === '...'` strings and hit those. Also grep the
CORRECT dispatcher (`src/web.ts`, not `src/web/web.ts`) for the handler's mount. If the live endpoint
already answers, STOP and report the correction to Boss -- do not deploy on a false premise.

The dashboard server is `node dist/index.js` in tmux session **marveen** (= MAIN_AGENT_ID),
supervised by `scripts/fleet-supervisor.sh` (60s tick, detect-and-START only, liveness = HTTP
:3420/api/health). The orchestrator (Genesis) runs SEPARATELY in **marveen-channels** -- NEVER touch
it for a dashboard deploy. A deploy only activates code on the RUNNING server; merging to develop is
not a deploy. **Needs Genesis-GO.**

**Reboot-already-deployed check (confirmed 2026-06-13) -- DO THIS BEFORE any rebuild+restart.** A host
reboot / WSL restart relaunches the server, which loads whatever `dist/` currently holds. If `dist`
was rebuilt AFTER a fix merged (even if never manually restarted), the reboot activates that fix for
free -- the merged code may ALREADY be live, making a redundant rebuild+restart pure risk. Verify
first: (1) `dist/index.js` mtime vs the fix's merge-commit time (`git show -s --format=%ci <merge>`);
(2) grep the BUILT dist for the fix's symbol (`grep -rl <newSymbol> dist/`); (3) the serving pid's
start time (`ss -ltnp | grep 3420` -> pid -> `ps -o lstart -p <pid>`) postdates the reboot. If dist
mtime > merge time AND the symbol is in dist AND the serving pid started at/after the reboot, the fix
is LIVE -- skip the restart, just verify + report. (2026-06-13: #130 delivery-fix was already live this
way after a 12:15 reboot; dist built 22:00 the prior night, 2 min after the 21:58 merge.)

**Deploy-delta awareness (orchestrator step, confirmed 2026-06-07).** A restart activates the WHOLE
develop backlog accumulated since the last deploy, not just the feature you merged. Before asking Boss
for the GO, enumerate the full delta and flag risky items: `git log --oneline --grep="Merge PR"
<deployed-tip>..origin/develop` (deployed build often lags many PRs; check `dist/index.js` mtime / the
last deploy entry in the daily log). When the batch includes behaviour-changing PRs (auth/session
cookie, rate-limiting, watchdog/launch changes), say so explicitly in the GO request so Boss approves
the actual surface, not just "my one feature". Never restart for a single feature without surfacing
what else rides along.

**CONSUMER-AGENT MCP RESTART when the delta touches `src/mcp/*` (confirmed 2026-09-21, #665 recurrence).**
A dashboard restart activates the new `dist/` for the SERVER, but NOT for the MCP stdio subprocesses
that consumer agents run. Each agent (e.g. Claudia) spawns its own `node dist/mcp/<x>-mcp-server.js`
child AT ITS SESSION START; that child keeps running the dist it loaded then. So a deploy whose delta
changes `src/mcp/google-mcp-server.js` (a new tool param, schema field) is LIVE in the server + freshly
built in dist, yet the consumer agent's MCP child still runs the OLD schema -- and zod SILENTLY STRIPS
the unknown key, so the tool "accepts but ignores" the new field. Exactly the #665 symptom: recurrence
built into dist at 16:23 but Claudia's google-mcp child (pid 18520) started 14:41, dropped the
`recurrence` key on every create/update. (calendarId from #664 worked because that child started 14:41 >
the 14:40 #664 build -- perfectly consistent.)
- **Detect:** for each consumer agent that uses the changed MCP, compare its MCP-child start time vs the
  dist build mtime: `for p in $(pgrep -f 'dist/mcp/<x>-mcp-server.js'); do echo "$p $(date -d @$(stat -c %Y /proc/$p) +%T)"; done` vs `stat -c %y dist/mcp/<x>-mcp-server.js`. child_start < dist_mtime = STALE.
- **Fix = session-recycle the consumer agent** (the stdio child does NOT self-respawn, and you cannot
  script an agent's interactive `/mcp`): `tmux kill-session -t agent-<id>` -> its watchdog respawns a
  fresh session whose MCP children load the current dist. Confirm the agent has a watchdog first
  (`pgrep -af '<id>-watchdog'`) so it comes back. VERIFY after: the new MCP child's start > dist mtime,
  and the old stale pid is gone.
- **Add to the GO request / post-deploy:** if the delta touches `src/mcp/*`, name which consumer agents
  need a recycle -- the deploy is NOT fully live for them until their MCP restarts. See the cold/shared
  `mcp-server-dist-activation-gap` lesson.

**Genesis-GO time-box (card 44ac5d9a, confirmed weakness 2026-07-01).** A GO-keres utan NEM blokkolsz
csendesen hataridatlanul. Protocol:
1. GO-keres kikuldese utan **jegyezd a kanban kartyan**: `[AWAITING-GO since HH:MM, deadline HH:MM+4h]`
   a kartya body-jaban (vagy comment-szeru append).
2. Ha **4 orán belül** nem erkezik GO: auto-eszkalacio Bossnak Telegramon (Armorer bot, chat_id
   8643929442): "Deploy [X] vár GO-ra 4+ órája -- továbbra is várok, vagy elejtem?" -- EGY uzenet,
   nem loop.
3. Ha **8 órán belül** sem erkezik valasz: kartya statuza `waiting`, body-ba `[BLOCKER: GO not received
   by HH:MM -- deploy on hold]`, es jelzed marveen-nek inter-agentben hogy eszkalalt.
4. GO megkapasa utan azonnal torolheted az awaiting-annotaciokat a kartya body-jabol.

Blocker-reason dokumentalas: ha a GO barmilyen okbol nem erkezik meg (Boss nem elerheto, limit,
kulso fuggoseg), a kartya body-jaba keruljon a blokker oka es az utolso eszkalacio ideje -- soha ne
maradjon csendben rothado "waiting" kartya. (Lasd kanban-status-hygiene: waiting = genuinely blokkolt,
es a blokker neve latszik a kartyaban.)

## Procedure

0. **Rollback point + pre-GO gate -- ONE command, BEFORE asking for GO. Paste the verdict into the
   GO request:**
   ```bash
   bash scripts/deploy-backup.sh                # exit 0 = safe to ask; exit 1 = do NOT ask
   ```
   It copies the live `dist/` to `/tmp/marveen-deploy-backups/<ts>/`, labels it with
   `deployed-sha.txt`, then runs `scripts/deploy-preflight-unifier.sh`. Neither half touches the live
   system, so no GO is needed to run it.
   **The backup comes FIRST on purpose.** It used to be taken after the GO, which made C3 ("the live
   build has a rollback point") structurally red at every pre-GO with nothing the operator could do
   about it -- and a permanently red gate is one people learn to skip (thor N1 / devil-advocate
   DA-11, PR#462). It was also three hand-typed lines, which is why only 2 of 54 backups on disk
   carry a `deployed-sha.txt` at all. Do not hand-roll the backup any more; use the script, so the
   flat layout `rollback.sh` requires stays an invariant instead of a convention.
   The gate chains delta-risk + hook presence (C1), target-ref currency checked against the remote
   plus deployed-tip position (C2), the rollback point `scripts/rollback.sh` would ACTUALLY restore
   (C3), build recency (C4), and whether every running repo shell process is executing current
   on-disk code (C5).
   **C5 is the one that is easy to skip and the one that matters most.** A deploy of a shell file
   (`fleet-supervisor.sh`, any `*-watchdog.sh`) changes the DISK; the running process keeps executing
   the copy it parsed at startup. On 2026-08-04 the supervisor had been running a deleted inode since
   07-26, so OPS-079, OPS-076 and OPS-080 were all "deployed" and all inert -- and a sweep found 26
   more stale processes. Nothing in the 4-point verify looks at running processes, so if you skip
   this step nothing else will catch it. A shell-file deploy is not done until the process restarts.
   If C5 reports STALE, restart those processes as part of the deploy (see Gotcha A for the ordering
   hazards) or state explicitly in the GO request which changes are shipping inert.

1. **Sync + build** from the released tip:
   `git checkout develop && git reset --hard origin/develop` then `npm run build`. Confirm
   `dist/index.js` mtime is fresh. The running server is untouched until the restart.
   **CAUTION (confirmed 2026-06-07): if the live checkout has UNCOMMITTED operational drift** (e.g.
   `scripts/fleet-supervisor.sh` / `seed-config/*.json` edits the RUNNING supervisor reads but that
   aren't merged), a blind `git reset --hard` WIPES them and the next supervisor tick regresses.
   Instead: `git stash push -- <those files>`, `reset --hard origin/develop`, `git stash pop` (3-way
   reapplies onto merged hunks; grep to confirm both changes coexist). Better: get the drift merged
   first (reconcile PR) so the reset is clean. Untracked files (watchdog scripts, workflow `.js`)
   survive `reset --hard` (only `git clean` removes them) -- never `git clean` here.
   **ISOLATED-WORKTREE BUILD when the main tree is on ANOTHER agent's active branch (confirmed
   2026-06-14).** If the main working tree HEAD is NOT develop -- e.g. an engineer agent committed
   on a feature branch IN the shared checkout (`git worktree list` shows `/home/domin/marveen` on
   `feat/...`, and that agent's cwd is inside the repo) -- do NOT `checkout develop`/`reset --hard`
   in the main tree: it churns the live agent's HEAD mid-task AND wipes operational drift. `dist/` is
   gitignored (`git check-ignore dist/index.js`), so build elsewhere and copy ONLY the artifact:
   `git worktree add --detach /home/domin/marveen-wt/deploy-live <origin/develop-sha>` ->
   `ln -sfn /home/domin/marveen/node_modules <wt>/node_modules` -> `(cd <wt> && npm run build)` ->
   (the rollback point was already taken in step 0 by `scripts/deploy-backup.sh`, which also writes
   the `deployed-sha.txt` rollback.sh needs -- do not hand-roll a second one here) ->
   `rsync -a --delete <wt>/dist/ /home/domin/marveen/dist/` -> restart (step 3). The main tree's HEAD/branch/src/drift are never
   touched; verify with `grep -rl <new-symbol> dist/` before restart. This run deployed #143-148 while
   Dave concurrently merged #149 in the main tree -- zero collision, drift preserved, reply pipe
   survived. Give the active agent a one-line heads-up ("don't `npm run build` in the main tree for
   ~3 min") so a concurrent build can't clobber dist between copy and restart.
   **SOURCE-TREE SYNC (confirmed 2026-06-17, hook-block incident).** The server runs `dist/` only,
   but agent hooks (`scripts/hooks/*.py`, referenced in each agent's `settings.json`) execute from
   the SOURCE TREE at their absolute paths -- NOT from `dist/`. If the source checkout lags the
   deployed tip (e.g. local `develop@54d612f` while deploying `65d4381e`), newly-added hook scripts
   are absent from disk: Python exits 2 ("can't open file") which Claude Code treats as a hard deny
   -> fleet-wide Bash/Write/Edit block on every agent that references them (confirmed 2026-06-17:
   `guardrail-permission-rules.py` missing -> Hibiki + Forge Bash blocked). After the worktree build
   and rsync, confirm the source checkout matches the deployed tip:
   `git -C /home/domin/marveen rev-parse HEAD` == deployed SHA.
   If it lags: `git -C /home/domin/marveen fetch origin develop` then
   `git -C /home/domin/marveen reset --hard <deployed-sha>` (ONLY when no agent is mid-commit on a
   feature branch in the main tree -- check `git branch --show-current` first; if on a feature
   branch, ping Dave to ff-sync his branch before you restart). This is a pre-restart gate, not
   optional.
   **POST-SYNC GREP-ASSERT (D-3, card 372dcb5a).** After source-sync, assert the fix you just deployed
   is actually present in the working-tree source files (not just in dist). The PR#332 incident: fix
   merged + rsync'd but working-tree hook was stale -> fix never activated on-disk. Pattern:
   ```bash
   # Replace UNIQUE_SYMBOL with a distinctive string from the merged fix (new function, comment keyword).
   grep -rl "UNIQUE_SYMBOL" /home/domin/marveen/scripts/hooks/ /home/domin/marveen/scripts/ 2>/dev/null \
     || echo "WARN: fix symbol not found in source -- source-sync may still be stale"
   ```
   If the symbol is absent, re-run the SOURCE-TREE SYNC reset before restarting.
2. **Record pre-state** (baseline for the pipe-watch): the main MCP poller presence
   (`probeChannelPollerPresence("telegram", undefined)` should be `true`) and the session list.
3. **Restart** the dashboard with the supervisor's EXACT command (so the supervisor does not fight it).
   **FIRST: write the planned-restart marker** so the supervisor-sentinel suppresses its relaunch alert
   (PR #156, merged b4f4b67). Without it the sentinel fires a noisy alert each planned restart.
   ```bash
   touch /home/domin/marveen/store/planned-restart.marker   # suppress sentinel alert noise
   PATH_CURATED="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
   NODE="$(command -v node)"; TMUXB="$(command -v tmux)"
   env -u TMUX "$TMUXB" kill-session -t marveen 2>/dev/null || true
   env -u TMUX "$TMUXB" new-session -d -s marveen -c /home/domin/marveen "export PATH=\"$PATH_CURATED\" && exec $NODE dist/index.js"
   ```
4. **4-point verify** (all must be green):
   **MACHINE-VERIFY FIRST (card 372dcb5a) -- call `/api/gate/verify` before any manual check:**
   ```bash
   TOKEN=$(cat /home/domin/marveen/store/.dashboard-token)   # reference only -- guard-BLOCKED (env-file-print)
   curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/gate/verify | python3 -m json.tool
   ```
   > NOTE (guard): the `$(cat ...)` assignment will not run. Use `python3 scripts/noa-api.py GET /api/gate/verify`, or a one-off `.py` that reads the token via script-file `open()`. See fleet-ops for the canonical recipe.
   200 + `"pass": true` = all 4 F-checks green, skip the manual detail below and proceed to step 5.
   503 or `"pass": false` = look at `checks.F1/F2/F3/F4` for which point failed, then consult the
   manual detail to diagnose and fix. Rollback if F2/F3 fail and cannot be resolved within ~5 min.
   **GOTCHA (F5 manual check, confirmed 2026-09-20): `ps|grep dist/index` false-matches the tmux
   WRAPPER.** The server session is `tmux new-session -d -s marveen ... exec node dist/index.js`; that
   wrapper process is LONG-LIVED (survives node restarts) and its argv literally contains
   `node dist/index.js`, so a grep on `dist/index` returns the OLD-dated wrapper as if it were the
   server -> false "not restarted" verdict (2026-09-20: mistook the Sep19 wrapper for the server and
   needlessly re-routed a restart that had already succeeded). Read the REAL node child: `ps -o
   pid,lstart,cmd -C node | grep 'dist/index'` and take the line whose cmd starts with a node binary
   (not `tmux new-session`), or the port owner `ss -ltnp 'sport = :3420'`. Better: just trust
   `/api/gate/verify` F5 (server-side, correct). Never re-route a peer's "stuck" deploy off a raw grep.

   Manual detail (for diagnostics when `/api/gate/verify` reports a failure):
   - (1) **server up** [F1]: poll `:3420/api/health` until `401`/`200` (auth-gated = up). Confirm exactly
     ONE real `node dist/index.js` binds :3420: `ss -ltnp | grep 3420` -> one pid. (NOTE: `pgrep -fc
     'node dist/index.js'` over-counts -- a stale `tmux new-session ... node dist/index.js` arg row and
     your own grep match. Trust `ss` + the tmux pane pid, not the pgrep count.)
   - (2) **sessions + watchdogs alive** [F2]: `tmux list-sessions` shows marveen, marveen-channels, and each
     agent-<name>; `pgrep -af` shows dave-watchdog / fleet-supervisor / thor-watchdog.
   - (3) **channel-recovery intent (new code live)** [F3]: `/api/agents/health` + direct
     `isAgentChannelIntentionallyEnabled` -> channel agents (dave/buster/thor) `true`, main `marveen`
     `false` on the sub-agent gate (the health API shows main `true` by the main special-case -- both
     correct). **Quick F3 auto-check**: `bash scripts/verify-channel-recovery-intent.sh` (PASS/FAIL,
     checks all 29 agents for configured-but-disabled death-loop state).
   - (4) **token vault-restore mechanism** [F4]: a channel agent has a vault env backup
     (`getSecret(channelEnvVaultId(name,"telegram")) != null`). A just-launched agent may lack one until
     its next launch -- not a failure.
   - (5) **hook-presence check (NEW, confirmed 2026-06-17).** Scan every agent's `settings.json`
     for `scripts/hooks/*.py` references and assert each file exists on disk. Missing = fleet-block
     risk (Python file-not-found exits 2 = deny-block). Run BEFORE restart AND in verify:
     ```python
     python3 - <<'PY'
     import os, json, glob, re
     settings_paths = (
         glob.glob("/home/domin/marveen/agents/*/.*/.claude/settings.json") +
         glob.glob("/home/domin/marveen/agents/*/.claude*/settings*.json")
     )
     referenced = set()
     for path in settings_paths:
         try:
             for m in re.finditer(r"scripts/hooks/[^\s\"']+\.py", open(path).read()):
                 referenced.add(m.group())
         except: pass
     missing = [f for f in sorted(referenced)
                if not os.path.exists("/home/domin/marveen/" + f)]
     if missing:
         print("MISSING HOOKS (FLEET BLOCK RISK):", missing); raise SystemExit(1)
     print(f"Hook-presence OK: {len(referenced)} checked, 0 missing")
     PY
     ```
     Any missing file = **HARD STOP before restart**: do NOT start the server until the source
     checkout is at the deployed tip (the new hook script must be on disk). See SOURCE-TREE SYNC above.
5. **Pipe-recovery watch (~110s)**: poll the main MCP poller presence every ~20s for ~2 minutes. The
   restart MAY kill the orchestrator's MCP child; item3 (channel-health-monitor, 45s initial + 60s
   interval) should auto-reconnect within ~60-105s. STABLE-true the whole window = no outage. A drop
   then recovery = item3 working. **Silence > 2 min = REGRESSION -> rollback + escalate to Genesis.**
   **TWO DISTINCT TELEGRAM PIPES -- do not conflate (confirmed 2026-06-05 PR#9 deploy):** (a) the
   DASHBOARD server's IN-PROCESS channel-monitor poller -- this is what item3 recovers, server-side,
   the thing this watch polls. (b) the ORCHESTRATOR (marveen-channels) session's OWN Telegram MCP
   stdio child -- the pipe Genesis's `reply` tool uses. **item3 does NOT recover (b).** A dashboard
   restart kills (b) and it stays dead until a human runs `/mcp` in the orchestrator terminal (the bun
   stdio child does not self-respawn). So after a deploy the server-side poller can be green while
   Genesis is still mute on Telegram; the verify can PASS on (a) while the Telegram success report is
   blocked on (b). Plan for it: send any user-facing Telegram BEFORE the restart if possible, and tell
   the user the orchestrator pipe may need a manual `/mcp`. **If (b) is down and you must deliver
   the user-facing report, do NOT wait for `/mcp`: send it via a DIRECT Bot API `sendMessage` (bot
   token at the ABSOLUTE path `/home/domin/.claude/channels/telegram/.env` OR repo-root
   `/home/domin/marveen/.env` `TELEGRAM_BOT_TOKEN=` -- SAME bot; use an absolute path, a bare
   `channels/telegram/.env` does NOT exist at the repo root and the curl will fail. Grep the
   `\d{8,12}:[A-Za-z0-9_-]{30,}` shape, never print it;
   `curl .../bot$TOKEN/sendMessage --data-urlencode chat_id=8643929442 --data-urlencode text=...`).
   That bypasses the dead pipe. CONFIRMED 2026-06-09: the telegram-pipe-watchdog does NOT auto-recover
   (b) here -- its 409-conflict probe reads the pipe as alive because the dashboard's own poller
   polls the same bot (the 409 blind spot), so a `/mcp` by Dominik is required for inbound. Don't
   hand-roll a self-`/mcp` via send-keys (the menu needs navigation -> can wedge the session). See the
   `reply-tool-down-botapi-fallback` memory.** (Open follow-up: auto-reconnect (b).)
6. **Remove the planned-restart marker** (after all 4 verify points are green):
   ```bash
   rm -f /home/domin/marveen/store/planned-restart.marker
   ```
   The marker has a 30-min TTL (auto-expires) but explicit removal is cleaner. A real crash after
   this point will fire the loud sentinel alert as expected.
6b. **Update the deployed-tip marker** (card 1122c2ff -- ALWAYS after a successful deploy or rollback):
   ```bash
   bash /home/domin/marveen/scripts/update-deployed-tip.sh
   # rollback: bash scripts/update-deployed-tip.sh <rollback-sha>
   ```
   Writes the actual live tip to `store/.deployed-tip` so `deploy-delta-check.py` has the correct
   base for the next pre-deploy risk scan. Forgetting this causes the delta to undercount PRs
   (confirmed 2026-06-22 Phase A: deployed bc07b9c but marker stayed at f71c2863 from PR#223).
7. **Report** to Genesis with the per-point evidence; if user-felt, Dave adds the Telegram report.

## Rollback
Keep the prior `dist` (or the prior released tip) recoverable. On any verify failure or >2min silence:
use the **one-command rollback script** (2026-07-30):
```bash
bash /home/domin/marveen/scripts/rollback.sh                    # auto-finds latest backup
bash /home/domin/marveen/scripts/rollback.sh /tmp/marveen-deploy-backups/20260729-182403  # specific
```
The script: writes planned-restart marker, rsync backup->dist, tmux restart, polls server up (40s),
runs /api/gate/verify, updates deployed-tip on green. Exit 0=green, 1=not green (escalate), 2=fatal.

**Backup dir format**: `/tmp/marveen-deploy-backups/YYYYMMDD-HHMMSS/` -- the dist FILES are directly
inside (not in a `dist/` subdir). So restore rsync is `rsync -a "$BACKUP/" dist/`, not `rsync -a "$BACKUP/dist/" dist/`.

If prefer manual: rebuild from the last-good tip (`git reset --hard <prev>` + `npm run build`) and re-run step 3, then
re-verify. Escalate to Genesis immediately.

**Backup OUTSIDE the working tree (confirmed 2026-06-05).** Put any `dist` backup in
`/tmp/marveen-deploy-backups/<ts>/` (or another path outside the repo), NEVER at the repo root as
`dist.backup-*`. An in-tree backup dir is untracked junk that (1) vitest scans into -> ~6 phantom
suite failures for everyone who runs the full suite, and (2) gets swept into another agent's PR by a
`git add .` on the shared working tree. The git history is already the authoritative rollback source,
so the on-disk backup is a convenience copy only -- keep it out of the tree, and delete it once the
deploy is verify-stable.

## Launch-env / credential migration roll (confirmed 2026-06-09, PR#85 OAuth migration)
A DIFFERENT deploy shape from the dashboard restart above: when a merged PR changes the AGENT
LAUNCH path (watchdog cmds, `channels.sh`, a sourced env helper) rather than server code, "deploy"
means **re-launching each agent** so its new process inherits the change -- no `npm run build`, the
dashboard server is untouched. Needs Genesis-GO (fleet-wide, re-launches every agent).
- **Verify the candidate BEFORE the gate, on the Buster sandbox, with the REAL production launch
  fragment** -- not the chameleon `morph+smoke` (that uses Buster's OWN launch path, so it does NOT
  exercise a watchdog-launch-cmd edit). Tonight's dedicated probe: `store/fleet-oauth-sandbox-verify.sh`
  (throwaway tmux session against Buster's cfg dir, checks boot-health + the var via `grep -aqz` on
  `/proc/<pid>/environ` -- **value never printed**). Run it again post-merge with the LIVE helper.
- **Roll CANARY-FIRST, sequentially, stop-on-first-failure.** Bounce ONE low-risk agent (a channel-less
  one, e.g. scout), independently verify it came back healthy AND carries the change, only THEN roll the
  rest one-by-one. If any agent doesn't return within ~220s, STOP -- one stuck agent, not the whole fleet.
- **Bounce = session-scoped, NEVER `pkill -f`.** Two-step because the watchdog is a long-lived process
  running the OLD `launch()`: (1) watchdog-process PID-scoped kill (verify cmdline first) -> supervisor
  respawns it with current code; (2) `tmux kill-session -t agent-<id>` -> the fresh watchdog relaunches
  with the new env. ~110s/agent (supervisor tick + watchdog cooldown + claude boot + resume-menu).
- **Per-agent verify** (reusable: `/tmp/verify-agent-token.sh <id>` from this run): find the claude pid
  under the agent's tmux pane and `grep -aqz '^<VAR>=' /proc/<pid>/environ` -- value never printed.
- **Agents OFF the migrated path are NOT failures, they're deferred-by-design**: the orchestrator
  (Genesis) and the agent DOING the roll (Dave) must not bounce themselves mid-task (-> natural restart);
  `heartbeat` (token-probe loop) and `buster` (c12 harness) launch off DIFFERENT paths, so a watchdog-cmd
  migration skips them -- they keep the legacy creds = a residual gap to close as a separate task.
- **Gotcha A -- stale supervisor ensure-list.** A bounced agent may NEVER respawn if the long-lived
  supervisor predates the commit that added it to `ensure_channel_watchdogs` (bash parses functions at
  start -> its in-memory list is old). Symptom: some agents revive after the bounce, one specific agent
  doesn't. Fix: PID-scoped supervisor restart (kill the old supervisor pid -> fresh relaunch on current
  code). On-disk code being correct + a dry-run confirms it's a staleness, not a code bug.
- **Gotcha B -- inherited flock fd survives the supervisor.** If the dashboard `node` was started while
  holding the supervisor's flock fd open, the lock lives on after you kill the old supervisor, so the new
  one exits "lock held". Fix: `rm` the 0-byte lock file (flock is inode-level -> a fresh inode = clean
  lock), dashboard untouched. Permanent fix (card it): open the flock fd `O_CLOEXEC` / `9>&-` at the
  dashboard+channels launch so restarts don't need this recovery.
- **Gotcha C -- the #90 dashboard sentinel races your manual supervisor restart (confirmed 2026-06-09,
  #88+#90 deploy).** Once PR #90 (who-watches-the-watcher) is LIVE, the freshly-restarted dashboard
  pgrep-checks the supervisor every 60s and setsid-relaunches it on death. So the moment you kill the
  stale supervisor to pick up a `fleet-supervisor.sh` change (e.g. #88's `9>&-`), BOTH the sentinel AND
  your manual `setsid bash fleet-supervisor.sh` may start one -> two contenders, `flock -n 9` arbitrates,
  the loser exits. This is benign (a positive sentinel proof), but it means **`pgrep -fc` over-counts and
  the "up" log line alone is ambiguous** -- VERIFY single-instance by which PID actually holds the lock:
  `for p in $(pgrep -f fleet-supervisor.sh); do ls -la /proc/$p/fd/ | grep -q fleet-supervisor.lock && echo "$p HOLDS"; done`
  (your own Bash-tool wrapper also false-matches the pgrep). **CONFIRMED 2026-09-20: this self-match will
  BLOCK the sentinel relaunch.** The sentinel's liveness probe is `pgrep -f 'scripts/fleet-supervisor\.sh'`;
  while your verification/polling command (which contains that literal string in its args) is running, the
  sentinel sees "supervisor alive" and does NOT relaunch -- so a long `for i in $(seq ...); do ... pgrep
  fleet-supervisor ...; done` busy-wait after a kill silently masks the down-state for its whole duration and
  the auto-relaunch never fires. Don't diagnose supervisor-down with commands that name the script; use the
  lock-holder scan (`find /proc/[0-9]*/fd -lname '*fleet-supervisor.lock*'`) or just relaunch it yourself
  (flock arbitrates). Order that works cleanly: kill stale
  supervisor -> restart dashboard with the on-disk launch (`9>&-`) -> `rm` the lock (Gotcha B) -> let
  EITHER the sentinel or a manual setsid relaunch win; confirm exactly one PID holds the lock + watchdogs
  re-ensured. The dashboard restart itself activates the sentinel (`dist/web/supervisor-sentinel.js`).
  **SIMPLEST when the sentinel is already live (confirmed 2026-06-14, da737e92 restart): just PID-kill the
  supervisor and let the sentinel relaunch it -- it fires within ~1s of death (faster than its 60s poll
  suggests; it detects the gone-PID immediately) and acquires the freed lock (the killed PID's fd close
  releases it). A manual setsid relaunch then almost always LOSES the flock race and exits "another
  fleet-supervisor is already running (lock held)" -- benign, not a failure. So don't bother racing it;
  and DON'T PANIC at a transient "no supervisor found" window in the first ~5-10s while the relaunch
  settles -- wait ~10s, then verify single-instance + lock-holder. The relaunched supervisor is parented
  to the dashboard pid (ppid = the :3420 node), which is how you tell the sentinel-launched one from a
  manual `/init`-parented one. ensure_main_channel_watchdog (da737e92) fires on its first tick: confirm
  with `pgrep -f "channel-watchdog.sh --loop"` + the `channel-watchdog: started (--loop)` log line.**

## Buktatók
- Do NOT kill/restart `marveen-channels` (the orchestrator) -- only the `marveen` dashboard session.
- `env -u TMUX` is required or tmux tries to nest and binds to the caller's pane.
- Use the supervisor's exact PATH + command, else a word-split / wrong-node launch dies silently.
- The new code only takes effect for ALREADY-RUNNING agents on THEIR next restart (slim CLAUDE.md,
  etc.); the dashboard server itself is fresh immediately.
- **STALE SUPERVISOR when a deploy edits `scripts/fleet-supervisor.sh`** (confirmed 2026-06-07, #61
  added `ensure_token_outage_watch`). The RUNNING supervisor is a long-lived bash process -- it does
  NOT re-read its own script, so a newly-wired watchdog (`ensure_<x>`) will NOT start until the
  supervisor itself restarts (i.e. next reboot via fleet-boot.sh, which runs the on-disk = new
  script). Convention here is NOT to force-restart the supervisor mid-deploy. Instead, **manually
  launch the new watcher once to bridge the current session**: `nohup bash scripts/<new-watch>.sh >
  /tmp/<x>.log 2>&1 &` -- reboot-persistence is already on disk, and the `ensure_<x>` fn dedups via
  `pgrep` so it won't double-start after the next supervisor restart. Verify the watcher's own log
  shows healthy cycles before declaring the feature live.

## Ellenőrzés
- `ss -ltnp | grep 3420` -> exactly one node pid.
- `/api/agents/health` returns 200 with the expected intent flags.
- pipe-watch verdict: STABLE or recovered-within-105s. Otherwise rollback.
- **Pid/dist freshness check** (confirmed 2026-08-26 PR#540 incident -- Dave caught manually):
  After restart, verify that the running pid started AFTER the dist build. Stale in-memory code
  means the restart was missed or the supervisor relaunched the old binary.
  ```bash
  PID=$(ss -ltnp | grep 3420 | grep -oP 'pid=\K[0-9]+')
  DIST_MTIME=$(stat -c %Y /home/domin/marveen/dist/index.js)
  PID_START=$(stat -c %Y /proc/$PID 2>/dev/null || echo 0)
  if [ "$PID_START" -lt "$DIST_MTIME" ]; then
    echo "STALE: pid $PID started before dist build -- restart needed"
  else
    echo "FRESH: pid $PID is running new dist"
  fi
  ```
  If STALE: do a targeted restart (don't skip -- the whole point of the deploy is lost).

## Remote / mobile access onboarding (confirmed 2026-06-05 Tailscale flip)
When the dashboard is reachable remotely (Tailscale Serve `https://<host>.ts.net/`, tailnet-only)
and a user (phone / new device) needs to log in:
- **Use the `?token=` deep-link, NOT manual paste.** `web/app.js` reads `?token=` from the URL,
  stores it in `localStorage['marveen-dashboard-token']`, strips it from the URL, then attaches it
  as `Bearer` on every same-origin `/api/*` fetch. A manual hand-typed/pasted token on a phone is
  error-prone -> on a 401 the frontend deletes the token and re-prompts = an endless re-prompt loop
  that looks like "I enter the token but it asks again". The link bypasses the paste entirely:
  `https://<host>.ts.net/?token=<TOKEN>` (token from `store/.dashboard-token`).
- **Diagnosis tap (proves token-good vs client-side):** run as `python3 scripts/noa-api.py GET /api/auth/status` (the inline `$(cat ...)` below is reference only -- guard-BLOCKED):
  `curl -H "Authorization: Bearer $(cat store/.dashboard-token)" http://127.0.0.1:3420/api/auth/status`
  -> `{"authenticated":true}` means the token is valid and the server accepts it, so a re-prompt loop
  is CLIENT-side (paste typo, or the browser not persisting localStorage: private/incognito mode or
  strict tracking-prevention -> tell the user normal tab / Chrome).
- **Tailscale Serve prereqs** (see the `tailscale-serve-private` memory): `serve` needs operator perms
  -> one-time `sudo tailscale set --operator=<user>` (NOPASSWD works on this host, agent-runnable);
  HTTPS cert toggle ON in the tailnet admin; verify `AllowFunnel=null` (tailnet-only, NOT public).
  Don't self-curl the `.ts.net` name FROM the WSL host (loopback can't resolve own MagicDNS) -- the
  authoritative functional test is the user's device.
