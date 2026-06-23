export const meta = {
  name: 'phantom-executor',
  description: 'Execute a pre-computed phantom ExecutionPlan: launch worktree-isolated eng agents wave by wave, branch+push only, never PR. Plan comes from scripts/phantom-plan.ts via args.',
  phases: [{ title: 'Phantoms' }],
}

// Card 9118c069: the thin, sandboxed executor half of the phantom runner.
//
// A Workflow script cannot import TS modules, so all planning (parse / validate /
// conflict-detect / wave) is done ahead of time by scripts/phantom-plan.ts (which
// composes src/phantom/runner.ts + the four E2 modules). That planner emits an
// ExecutionPlan JSON; pass it to this workflow as `args`:
//
//   npx tsx scripts/phantom-plan.ts <manifest-dir> > /tmp/plan.json
//   # then invoke this workflow with args = JSON.parse(/tmp/plan.json)
//
// This file only launches the plan: each wave runs concurrently (worktree
// isolation); a barrier separates waves so a dependent never starts before its
// dependency's wave is done. Conflicts were already serialised into separate
// waves by the planner, so nothing here re-derives scheduling.

const plan = args
if (!plan || typeof plan !== 'object' || !Array.isArray(plan.tasks) || !Array.isArray(plan.waves)) {
  throw new Error('phantom-executor: `args` must be an ExecutionPlan from scripts/phantom-plan.ts (run the planner first and pass its JSON as args)')
}

const byId = new Map(plan.tasks.map((t) => [t.id, t]))

phase('Phantoms')
log(`Phantom executor: ${plan.tasks.length} task(s) across ${plan.waves.length} wave(s).`)
if (Array.isArray(plan.conflicts) && plan.conflicts.length > 0) {
  log(`${plan.conflicts.length} pre-conflict(s) auto-serialised into separate waves.`)
}

const results = []
for (let w = 0; w < plan.waves.length; w++) {
  const wave = plan.waves[w].map((id) => byId.get(id)).filter(Boolean)
  if (wave.length === 0) continue
  log(`Wave ${w + 1}/${plan.waves.length}: ${wave.map((t) => t.id).join(', ')}`)
  const waveResults = await parallel(
    wave.map((t) => () =>
      agent(t.prompt, {
        label: `phantom:${t.id}`,
        phase: 'Phantoms',
        schema: plan.schema,
        isolation: 'worktree',
        model: t.model,
      }).then((r) => ({ id: t.id, card: t.card, result: r })),
    ),
  )
  results.push(...waveResults.filter(Boolean))
}

// Self-report triage mirrors the retired prototypes: a phantom is "clean" only
// if it pinned the develop base, made exactly one commit, left the main checkout
// clean, and pushed. The Thor+Dave gate (and evaluatePhantomResults for overrun)
// is the real verification afterwards.
const ok = results.filter(
  (d) => d.result && d.result.baseConfirmed && d.result.commitCount === 1 && d.result.mainCheckoutClean && d.result.pushed,
)
const bad = results.filter((d) => !ok.includes(d))

log(`Phantoms finished: ${ok.length}/${plan.tasks.length} self-report clean, ${bad.length} flagged.`)

return {
  total: plan.tasks.length,
  clean: ok.map((d) => ({
    id: d.id,
    card: d.card,
    branch: d.result.branch,
    files: d.result.filesChanged,
    typecheck: d.result.typecheck,
    tests: d.result.tests,
    commitCount: d.result.commitCount,
    summary: d.result.summary,
  })),
  flagged: bad.map((d) => ({
    id: d.id,
    card: d.card,
    baseConfirmed: d.result?.baseConfirmed,
    commitCount: d.result?.commitCount,
    mainCheckoutClean: d.result?.mainCheckoutClean,
    pushed: d.result?.pushed,
    blockers: d.result?.blockers || 'agent returned null/incomplete',
    summary: d.result?.summary,
  })),
}
