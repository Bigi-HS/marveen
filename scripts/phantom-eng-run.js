export const meta = {
  name: 'phantom-eng-run',
  description: '10 ephemeral worktree-isolated eng agents draining low-risk backlog in parallel (production+efficiency test)',
  phases: [
    { title: 'Phantoms' },
    { title: 'Verify' },
  ],
}

// Boss-authorized 2026-06-07: 10 parallel phantom eng agents helping Dave.
// Each agent: worktree-isolated, pins base to develop, branch+push only, NEVER opens a PR.

const REPO = '/home/domin/marveen'

const TASKS = [
  {
    key: 'execfilesync-595', card: '1d2665a2',
    title: 'capture-pane execSync -> execFileSync at agent-process.ts ~line 595',
    body: `In src/web/agent-process.ts at ~line 595 there is ONE remaining tmux capture-pane invocation using shell-interpolated execSync (\`\${TMUX} capture-pane -t \${session} -p\`). Convert it to execFileSync(TMUX, ['capture-pane','-t',session,'-p', ...]) argv form, matching the project's execfilesync-shell-quote-rule and the surrounding send-keys calls. Behavior must be identical (same captured output, same options). Do not touch unrelated lines.`,
  },
  {
    key: 'launcher-capture', card: '00cabbe7',
    title: 'capture-pane execSync -> execFileSync in launcher modal helpers',
    body: `In the tmux launcher module, the helpers answerResumeMenuWhenReady, dismissResumeSummaryModalIfPresent, dismissSurveyModalIfPresent (and sendPromptToSession around line 709) capture the pane via execSync string interpolation (\`\${TMUX} capture-pane -t \${session} -p\`) while their send-keys already use execFileSync argv. Switch every capture-pane call in these helpers to execFileSync(TMUX,[...]) for consistency and to follow execfilesync-shell-quote-rule. Grep the codebase for "capture-pane" to find the exact file/locations. NOTE: a sibling task is fixing agent-process.ts:595 separately -- only touch the launcher-modal helper file, NOT agent-process.ts, to avoid overlap.`,
  },
  {
    key: 'dbtest-cleanup', card: '7b0b39d0',
    title: 'db.test.ts advisory cleanup (Thor A1/A2)',
    body: `In the db test file (find it: src/**/db.test.ts): A1 -- the permissions test still touches a LIVE vault path; make it operate on a temp path instead (it currently does a safe 0o644->0o600 restore, but it should use a temp file so it never depends on the live vault). A2 -- there is dead code: a tempDbPath variable that is declared but unused; remove it. Keep all tests passing. Run the db test specifically and report the result.`,
  },
  {
    key: 'poller-probe', card: 'b1490c68',
    title: 'MCP-poller probe: shared per-tick ps scan + exact dir match (P9-F2/F3)',
    body: `Find probeChannelPollerPresence and parsePollerPidsFromPs (grep for them). P9-F2: today probeChannelPollerPresence runs one \`ps eww -e\` per channel-enabled agent per 60s tick. Refactor so ONE \`ps eww -e\` scan runs per tick and is sliced per agent (pass the scan result in, or cache it for the tick). P9-F3: parsePollerPidsFromPs uses substring includes() on \`<ENV>=<dir>\` which could false-positive when one dir is an exact prefix of another (e.g. telegram vs telegram-extra); anchor the match so a word/space boundary is required after the value. Preserve existing behavior for the real fleet dir names. Update/add unit tests if a test file for this exists.`,
  },
  {
    key: 'token-rotation', card: '57f32c1a',
    title: 'Dashboard token rotation via admin API without restart',
    body: `The dashboard Bearer token lives in store/.dashboard-token and currently only takes effect after a server restart. Add the ability to rotate it via an authenticated admin API endpoint WITHOUT restarting: an endpoint (e.g. POST /api/admin/rotate-token, protected by the current Bearer token) that generates a new token, writes it to store/.dashboard-token, and updates the in-memory value the auth middleware checks so the new token is valid immediately and the old one stops working. Mirror existing admin route patterns and auth. Return the new token in the response body. Add a focused test if the route layer is tested. Do NOT build UI -- API path only for this round.`,
  },
  {
    key: 'archetype-api', card: 'd410a410',
    title: 'Surface + set agent archetype via dashboard/API (Thor F2/F3)',
    body: `Follow-up to the archetype field added in commit a0c7f3b5. F2: getAgentSummary (agents route ~line 314) currently returns model but NOT archetype -- add archetype to the response object so the dashboard can show it. F3: there is no writeAgentArchetype helper and no route to SET the archetype (it's only changeable by hand-editing agent-config.json). Add a writeAgentArchetype setter and a route handler to set it, mirroring the existing writeAgentModel + its route exactly (same validation/auth shape). Add/extend tests mirroring the model setter's tests if present.`,
  },
  {
    key: 'hook-catalog', card: 'e6993102',
    title: 'Hook catalog: port 2-3 useful Claude Code settings.json hooks',
    body: `Selectively port 2-3 concretely useful Claude Code settings.json hooks (from the RuFlo 27-hook catalog idea) into this repo -- NOT all 27. Good candidates: a pre-send PII/injection scan hook (aligns with our AIDefence), a pre-deploy gate hook, a post-merge metrics hook. Implement them as documented, ready-to-wire hook scripts under scripts/hooks/ (match the style of any existing scripts/hooks/*) plus a short markdown doc (store/ or docs/) explaining each hook, what event it binds to, and the settings.json snippet to enable it. Do NOT modify the live settings.json -- deliver the scripts + the doc/snippets only. This is mostly additive new files; keep it self-contained.`,
  },
  {
    key: 'msg-recipient', card: 'msg-addr-guard-82870b',
    title: 'Messaging API: normalize/reject bad recipient (agent-X vs X)',
    body: `Inter-agent messages addressed to the tmux SESSION name (e.g. "agent-dave") instead of the agent NAME ("dave") stay pending forever and are silently lost. Fix POST /api/messages (find the messages route handler): (a) normalize an "agent-<n>" prefix to "<n>" IF an agent named <n> exists, AND (b) for an unknown/non-existent recipient return a 4xx error instead of silently accepting it as pending. Look at how agents are enumerated elsewhere in the codebase to validate existence. Add a focused test for both the normalize and the reject path if the route is tested. Keep the watchdog/heartbeat-for-stale-pending idea OUT OF SCOPE for this card -- just the normalize+reject guard.`,
  },
  {
    key: 'adaptive-compact', card: 'adaptive',
    title: 'Per-model adaptive compact threshold (contextWindow * 0.75)',
    body: `Builds on the token-aware /compact watcher merged in PR#26 (commit 123df86, src session-watcher module). Today the 250K threshold only fires for 1M-context (opus-4-8[1m]) agents and is a no-op for Sonnet/Haiku (200K). Generalize: make the threshold model-aware = model.contextWindow * 0.75 (Sonnet 200K -> ~150K, opus-1M -> ~750K) so every archetype gets a preemptive compact. Keep the existing idle-only + cooldown gating intact. Find where the contextWindow per model is known (model policy/config) and wire it in. Update the watcher's unit tests to cover at least the 200K and 1M cases.`,
  },
  {
    key: 'mcp-reconnect', card: 'mcp-reco',
    title: 'Orchestrator Telegram MCP auto-reconnect after deploy/restart',
    body: `When the dashboard server (marveen session) restarts it kills the orchestrator (marveen-channels) Telegram MCP stdio children; the existing server-side poller recovery does NOT restore the orchestrator's own MCP, so a manual /mcp is needed and Genesis goes silent after deploy. Implement detection + auto-reconnect: detect the pipe death (e.g. reply-failure signature, or poller-presence check for the orchestrator's OWN session) and trigger an automatic reconnect path so the orchestrator MCP self-heals after a deploy. Reference the fleet-deploy-verify skill step 5 (two separate pipes). Deliver this as a script (e.g. scripts/orchestrator-mcp-reconnect.sh or an extension of the existing telegram-pipe-watchdog) -- self-contained, do NOT wire it into fleet-supervisor/fleet-boot in this card and do NOT touch live sessions. Document the detection signal and recovery mechanism in a header comment.`,
  },
]

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key','branch','baseConfirmed','headShaShort','commitCount','diffStat','filesChanged','typecheck','tests','mainCheckoutClean','pushed','summary'],
  properties: {
    key: { type: 'string' },
    branch: { type: 'string' },
    baseConfirmed: { type: 'boolean', description: 'true if base was pinned to current develop HEAD before work' },
    headShaShort: { type: 'string', description: 'short sha the branch HEAD sits on top of (the develop base)' },
    commitCount: { type: 'integer', description: 'git rev-list --count develop..branch (should be 1)' },
    diffStat: { type: 'string', description: 'output of git diff --stat develop..branch' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    typecheck: { type: 'string', enum: ['pass','fail','skipped'] },
    tests: { type: 'string', description: 'pass/fail/skipped + which test + brief detail' },
    mainCheckoutClean: { type: 'boolean', description: 'true if /home/domin/marveen had no new src drift after work' },
    pushed: { type: 'boolean' },
    summary: { type: 'string', description: 'what was changed, 1-3 sentences' },
    blockers: { type: 'string', description: 'anything that blocked completion, empty if none' },
  },
}

function buildPrompt(t) {
  return `You are an ephemeral phantom engineering agent in the Genesis fleet, helping Dave drain the backlog. You work in a git worktree in ISOLATION. Follow this procedure EXACTLY.

TASK (kanban card ${t.card}): ${t.title}
${t.body}

MANDATORY PROCEDURE (the ephemeral-eng-workflow rules -- deviating breaks the run):
1. Read ${REPO}/store/fleet-eng-context.md fully -- it is the single source of truth, including the "Ephemeral worktree gotchas" section. Honor it.
2. Determine your worktree root: run \`pwd\` and \`git rev-parse --show-toplevel\` -> call it WT. ALL edits use ABSOLUTE paths under WT. A relative path can accidentally edit the main checkout ${REPO}; never risk it.
3. PIN THE BASE TO CURRENT develop (worktrees can land on a STALE commit -- this is the #1 failure):
   - \`git -C "$WT" fetch origin develop\`
   - \`git -C "$WT" checkout -B eng/eph-${t.key} origin/develop\`
   - Confirm: \`git -C "$WT" rev-parse --short HEAD\` MUST equal current develop HEAD (today's, around merge of PR#35 / sha 17f39b1 or newer). If it shows an old sha, STOP, do not commit, report baseConfirmed=false with the bad sha in blockers.
4. If $WT/node_modules is missing, symlink it: \`ln -s ${REPO}/node_modules "$WT/node_modules"\` (do NOT npm install).
5. Implement the task. Read the relevant files first (grep to locate symbols). Make the SMALLEST correct change. Match surrounding code style.
6. \`npm --prefix "$WT" run typecheck\` (or \`cd "$WT" && npm run typecheck\`). It MUST pass for your changed files. Then run the most relevant test (e.g. the specific test file you touched, or the nearest suite). Report honest pass/fail/skipped -- do NOT claim green if it is not.
7. Commit on your branch ONLY, conventional message, with trailer:
   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
   Exactly ONE commit. Then \`git -C "$WT" push -u --force-with-lease origin eng/eph-${t.key}\`.
8. SELF-VERIFY and report truthfully in the structured output:
   - \`git -C "$WT" rev-list --count origin/develop..eng/eph-${t.key}\` -> commitCount (must be 1)
   - \`git -C "$WT" diff --stat origin/develop..eng/eph-${t.key}\` -> diffStat + filesChanged (ONLY the files you intended; a huge deletion count means stale base = baseConfirmed must be false)
   - \`git -C ${REPO} status -s\` -> if it shows new src/ or .ts drift, mainCheckoutClean=false
9. NEVER open a PR, NEVER merge, NEVER push to develop. Branch + push only. The marveen orchestrator routes PRs through the Thor+Dave gate afterwards.

Return the structured output. Be brutally honest about pass/fail and base confirmation -- a false "done" wastes the gate's time.`
}

phase('Phantoms')
log(`Launching ${TASKS.length} phantom eng agents (worktree-isolated) in parallel...`)

const results = await parallel(TASKS.map((t) => () =>
  agent(buildPrompt(t), {
    label: `phantom:${t.key}`,
    phase: 'Phantoms',
    schema: SCHEMA,
    isolation: 'worktree',
    model: 'claude-sonnet-4-6',
  }).then((r) => ({ ...t, result: r }))
))

const done = results.filter(Boolean)
const ok = done.filter((d) => d.result && d.result.baseConfirmed && d.result.commitCount === 1 && d.result.mainCheckoutClean && d.result.pushed)
const bad = done.filter((d) => !ok.includes(d))

log(`Phantoms finished: ${ok.length}/${TASKS.length} self-report clean, ${bad.length} flagged.`)

return {
  total: TASKS.length,
  clean: ok.map((d) => ({ key: d.key, card: d.card, branch: d.result.branch, files: d.result.filesChanged, typecheck: d.result.typecheck, tests: d.result.tests, commitCount: d.result.commitCount, summary: d.result.summary })),
  flagged: bad.map((d) => ({ key: d.key, card: d.card, baseConfirmed: d.result?.baseConfirmed, commitCount: d.result?.commitCount, mainCheckoutClean: d.result?.mainCheckoutClean, pushed: d.result?.pushed, blockers: d.result?.blockers || 'agent returned null/incomplete', summary: d.result?.summary })),
}
