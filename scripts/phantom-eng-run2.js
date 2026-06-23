export const meta = {
  name: 'phantom-eng-run2',
  description: 'Phantom round 2: poller-f3 anchored match + agent-config version-control & read_model fail-loud',
  phases: [{ title: 'Phantoms' }],
}

const REPO = '/home/domin/marveen'

const TASKS = [
  {
    key: 'poller-f3', card: 'poller-f3-anchor',
    title: 'MCP-poller P9-F3: anchor parsePollerPidsFromPs ENV=dir match',
    body: `In src/web/channel-poller-reap.ts, parsePollerPidsFromPs matches a poller process by substring includes() on the string \`<ENV_VAR>=<dir>\`. This can FALSE-POSITIVE when one state dir is an exact prefix of another (e.g. a dir ".../telegram" would match a process whose env points at ".../telegram-extra"). Fix: anchor the match so the value must be followed by a word/space boundary (end-of-token), not just be a prefix. Grep for parsePollerPidsFromPs to find it; make the minimal change. Preserve behavior for the real fleet's fixed dir names. Add/extend a unit test in src/__tests__/mcp-poller-presence.test.ts proving the prefix case (telegram vs telegram-extra) no longer false-matches AND the exact-dir case still matches. This is the follow-up split from PR #42 (F2 already merged); parsePollerPidsFromPs body was untouched by #42.`,
  },
  {
    key: 'agentcfg-vc', card: 'agentcfg-vc',
    title: 'Version-control agent-config.json (no secrets) + read_model fail-loud',
    body: `Two parts (card agentcfg-vc, Thor's #48 follow-up). The agents/ dir is gitignored, so per-agent agent-config.json files are NOT version-controlled -> a fresh clone/deploy loses radar/bigben/etc model+team and the watchdog silently launches them on the wrong model.

PART A -- version-control ONLY agent-config.json (they contain NO secrets: keys are model/team/displayName/securityProfile/channelProvider/claudeConfigDir):
  1. HARD SAFETY GATE FIRST: grep EVERY agents/*/agent-config.json for secrets: \`grep -rIEl '(token|secret|api[_-]?key|password|bearer|sk-|ghp_|AKIA)' ${REPO}/agents/*/agent-config.json\`. If ANY file matches a real secret value, STOP, do NOT commit, report blockers with the offending file -- do not un-ignore a secrets-bearing file.
  2. Add a SPECIFIC negate rule to .gitignore so ONLY agent-config.json is un-ignored, NOT the rest of agents/ (which holds channel state/tokens). The dir is ignored as \`agents/\`, so you must un-ignore the dir path then re-ignore its contents except the config, e.g.:
       !agents/
       agents/*/*
       !agents/*/
       !agents/*/agent-config.json
     Verify with \`git check-ignore -v agents/radar/agent-config.json\` (should NOT be ignored) AND \`git check-ignore agents/radar/<some-other-file>\` (MUST still be ignored). Test that a known secret-bearing path under agents/ (e.g. any channel state file) is STILL ignored.
  3. \`git add\` all agents/*/agent-config.json. Confirm \`git diff --cached --name-only\` lists ONLY .gitignore + agent-config.json files, nothing else under agents/.

PART B -- harden read_model in scripts/agent-watchdog.sh (and any other scripts/*-watchdog.sh that define read_model the same way): today it does \`python3 -c "...get('model','claude-sonnet-4-6')" || echo claude-sonnet-4-6\`, a SILENT fallback. Make the fallback LOUD: when the config is missing/unparseable or has no model field, write a clear warning to the watchdog log / stderr (e.g. "WARN read_model: agents/<name>/agent-config.json missing or no 'model' -> defaulting to claude-sonnet-4-6") so a misconfig is visible, THEN still default (don't hard-stop the agent). Keep the happy path unchanged.

This touches watchdog scripts (lifecycle-adjacent) -> note in the PR that a c12 sandbox run is needed before DEPLOY; the code review/merge can proceed first. Run bash -n on every modified .sh.`,
  },
]

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['key','branch','baseConfirmed','headShaShort','commitCount','diffStat','filesChanged','typecheck','tests','mainCheckoutClean','pushed','summary'],
  properties: {
    key: { type: 'string' }, branch: { type: 'string' },
    baseConfirmed: { type: 'boolean' }, headShaShort: { type: 'string' },
    commitCount: { type: 'integer' }, diffStat: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    typecheck: { type: 'string', enum: ['pass','fail','skipped'] },
    tests: { type: 'string' },
    mainCheckoutClean: { type: 'boolean' }, pushed: { type: 'boolean' },
    summary: { type: 'string' }, blockers: { type: 'string' },
  },
}

function buildPrompt(t) {
  return `You are an ephemeral phantom engineering agent (Genesis fleet) in an isolated git worktree. Follow EXACTLY.

TASK (card ${t.card}): ${t.title}
${t.body}

MANDATORY PROCEDURE:
1. Read ${REPO}/store/fleet-eng-context.md (single source of truth incl. worktree gotchas).
2. WT = your worktree root (\`git rev-parse --show-toplevel\`). ALL edits use ABSOLUTE paths under WT. Never edit ${REPO} directly.
3. PIN BASE to current develop (worktrees can land stale -- #1 failure): \`git -C "$WT" fetch origin develop\`; \`git -C "$WT" checkout -B eng/eph-${t.key} origin/develop\`; confirm \`git -C "$WT" rev-parse --short HEAD\` == today's develop tip (around d445744 or newer). If old, STOP, baseConfirmed=false, sha in blockers.
4. If $WT/node_modules missing: \`ln -s ${REPO}/node_modules "$WT/node_modules"\`.
5. Implement the task. Smallest correct change, match surrounding style.
6. \`cd "$WT" && npm run typecheck\` must pass. Run the most relevant test. Honest pass/fail/skipped. For .sh changes run \`bash -n\`.
7. ONE commit, conventional msg, trailer "Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>". Then \`git -C "$WT" push -u --force-with-lease origin eng/eph-${t.key}\`.
8. SELF-VERIFY honestly: \`git -C "$WT" rev-list --count origin/develop..eng/eph-${t.key}\` (=1); \`git -C "$WT" diff --stat origin/develop..eng/eph-${t.key}\` (ONLY intended files; huge deletions = stale base = baseConfirmed false); \`git -C ${REPO} status -s | grep -E 'src/|\\.ts$'\` empty -> mainCheckoutClean.
9. NEVER open a PR/merge/push to develop. Branch + push only.

Return the structured output. Be brutally honest -- a false "done" wastes the gate. For the agent-config task: if the secret gate trips, baseConfirmed can still be true but pushed=false with the reason in blockers.`
}

phase('Phantoms')
log(`Phantom round 2: ${TASKS.length} agents (poller-f3, agentcfg-vc)...`)
const results = await parallel(TASKS.map((t) => () =>
  agent(buildPrompt(t), { label: `phantom:${t.key}`, phase: 'Phantoms', schema: SCHEMA, isolation: 'worktree', model: 'claude-sonnet-4-6' })
    .then((r) => ({ ...t, result: r }))
))
const done = results.filter(Boolean)
const ok = done.filter((d) => d.result && d.result.baseConfirmed && d.result.commitCount === 1 && d.result.mainCheckoutClean && d.result.pushed)
const bad = done.filter((d) => !ok.includes(d))
log(`Done: ${ok.length}/${TASKS.length} clean, ${bad.length} flagged.`)
return {
  clean: ok.map((d) => ({ key: d.key, card: d.card, branch: d.result.branch, files: d.result.filesChanged, typecheck: d.result.typecheck, tests: d.result.tests, summary: d.result.summary })),
  flagged: bad.map((d) => ({ key: d.key, card: d.card, base: d.result?.baseConfirmed, commits: d.result?.commitCount, clean: d.result?.mainCheckoutClean, pushed: d.result?.pushed, blockers: d.result?.blockers || 'null/incomplete', summary: d.result?.summary })),
}
