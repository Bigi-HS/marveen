// Card 9118c069: the phantom-runner planner. Composes the four pure E2 building
// blocks (manifest-guard / manifest-parse / manifest-schedule / gate-readiness)
// into an EXECUTION PLAN that a thin Workflow-JS executor consumes.
//
// Why the split (arch A, marveen 2026-06-23): a Workflow script runs sandboxed
// and cannot import TS modules, so it cannot call parseManifestTask / pickRunnable
// at runtime. Instead this planner (run via tsx, see scripts/phantom-plan.ts)
// parses + validates + conflict-checks + waves the manifest ahead of time and
// emits a self-contained JSON plan; scripts/phantom-executor.workflow.js receives
// that plan via the Workflow `args` global and just launches the agents wave by
// wave. This replaces the old hardcoded-TASKS prototypes
// (scripts/phantom-eng-run*.js) with a manifest-driven runner.

import { findParallelConflicts, type Conflict } from './manifest-guard.js'
import { parseManifestTask, validateManifest, type ParsedTask } from './manifest-parse.js'
import { pickRunnable } from './manifest-schedule.js'
import { evaluateGateReadiness, type GateDecision, type PhantomResult } from './gate-readiness.js'

export const DEFAULT_REPO = '/home/domin/marveen'
export const DEFAULT_PHANTOM_MODEL = 'claude-sonnet-4-6'

// The structured-output schema each phantom agent must return. Mirrors
// PhantomResult (gate-readiness.ts) so evaluatePhantomResults can score it.
export const PHANTOM_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'branch', 'baseConfirmed', 'headShaShort', 'commitCount', 'diffStat', 'filesChanged', 'typecheck', 'tests', 'mainCheckoutClean', 'pushed', 'summary'],
  properties: {
    key: { type: 'string' },
    branch: { type: 'string' },
    baseConfirmed: { type: 'boolean', description: 'true if base was pinned to current develop HEAD before work' },
    headShaShort: { type: 'string', description: 'short sha the branch HEAD sits on top of (the develop base)' },
    commitCount: { type: 'integer', description: 'git rev-list --count origin/develop..branch (should be 1)' },
    diffStat: { type: 'string', description: 'output of git diff --stat origin/develop..branch' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    typecheck: { type: 'string', enum: ['pass', 'fail', 'skipped'] },
    tests: { type: 'string', description: 'pass/fail/skipped + which test + brief detail' },
    mainCheckoutClean: { type: 'boolean', description: 'true if the main checkout had no new src drift after work' },
    pushed: { type: 'boolean' },
    summary: { type: 'string', description: 'what was changed, 1-3 sentences' },
    blockers: { type: 'string', description: 'anything that blocked completion, empty if none' },
  },
} as const

export interface PlanOptions {
  repo?: string
  model?: string
}

// A task ready for the executor: the parsed manifest fields plus the fully
// rendered agent prompt and the model to launch it on.
export interface PlannedPhantom {
  id: string
  card: string
  title: string
  files_touched: string[]
  model: string
  prompt: string
}

export interface ExecutionPlan {
  ok: true
  repo: string
  schema: typeof PHANTOM_RESULT_SCHEMA
  tasks: PlannedPhantom[]
  // Ordered batches of task ids. Every id in a wave may run concurrently (deps
  // satisfied by earlier waves, no mutual conflict). The executor runs each wave
  // with a barrier between waves -- the documented arch-A compromise, since the
  // sandboxed executor cannot call pickRunnable to schedule with no barrier.
  waves: string[][]
  // PRE-conflicts that were auto-serialised into separate waves (informational).
  conflicts: Conflict[]
}

export type PlanResult = ExecutionPlan | { ok: false; errors: string[] }

// The task fields the prompt template needs (subset of ParsedTask).
export interface PromptTask {
  id: string
  card: string
  title: string
  body: string
  files_touched: string[]
}

// Render the ephemeral-eng-workflow prompt for one task. Ported verbatim in
// substance from the retired scripts/phantom-eng-run.js prototype so behaviour
// is unchanged: worktree isolation, pin base to develop, branch+push only,
// never open a PR, brutally honest self-report.
export function buildPhantomPrompt(task: PromptTask, repo: string): string {
  const branch = `eng/eph-${task.id}`
  return `You are an ephemeral phantom engineering agent in the Genesis fleet, helping Dave drain the backlog. You work in a git worktree in ISOLATION. Follow this procedure EXACTLY.

TASK (kanban card ${task.card}): ${task.title}
${task.body}

MANDATORY PROCEDURE (the ephemeral-eng-workflow rules -- deviating breaks the run):
1. Read ${repo}/store/fleet-eng-context.md fully -- it is the single source of truth, including the "Ephemeral worktree gotchas" section. Honor it.
2. Determine your worktree root: run \`pwd\` and \`git rev-parse --show-toplevel\` -> call it WT. ALL edits use ABSOLUTE paths under WT. A relative path can accidentally edit the main checkout ${repo}; never risk it.
3. PIN THE BASE TO CURRENT develop (worktrees can land on a STALE commit -- this is the #1 failure):
   - \`git -C "$WT" fetch origin develop\`
   - \`git -C "$WT" checkout -B ${branch} origin/develop\`
   - Confirm \`git -C "$WT" rev-parse --short HEAD\` equals the current develop HEAD. If it shows an old sha, STOP, do not commit, report baseConfirmed=false with the bad sha in blockers.
4. If $WT/node_modules is missing, symlink it: \`ln -s ${repo}/node_modules "$WT/node_modules"\` (do NOT npm install).
5. Implement the task. Read the relevant files first (grep to locate symbols). Make the SMALLEST correct change. Match surrounding code style. Touch ONLY files covered by: ${task.files_touched.join(', ')}.
6. \`cd "$WT" && npm run typecheck\` MUST pass for your changed files. Then run the most relevant test (the specific test file you touched, or the nearest suite). Report honest pass/fail/skipped -- do NOT claim green if it is not. For any .sh change run \`bash -n\`.
7. Commit on your branch ONLY, conventional message, with trailer:
   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
   Exactly ONE commit. Then \`git -C "$WT" push -u --force-with-lease origin ${branch}\`.
8. SELF-VERIFY and report truthfully in the structured output:
   - \`git -C "$WT" rev-list --count origin/develop..${branch}\` -> commitCount (must be 1)
   - \`git -C "$WT" diff --stat origin/develop..${branch}\` -> diffStat + filesChanged (ONLY the files you intended; a huge deletion count means stale base = baseConfirmed must be false)
   - \`git -C ${repo} status -s\` -> if it shows new src/ or .ts drift, mainCheckoutClean=false
9. NEVER open a PR, NEVER merge, NEVER push to develop. Branch + push only. The marveen orchestrator routes PRs through the Thor+Dave gate afterwards.

Return the structured output. Be brutally honest about pass/fail and base confirmation -- a false "done" wastes the gate's time.`
}

// Compute conflict-free, dependency-ordered launch waves by repeatedly asking
// pickRunnable what may start once the previous waves are "done" (running empty:
// every pick is a fresh wave). Mutually-conflicting or parallel:false tasks fall
// into separate waves. Assumes the manifest already validated (acyclic); the
// progress guard below is defence-in-depth against a non-terminating loop.
export function computeWaves(tasks: ParsedTask[]): string[][] {
  const done = new Set<string>()
  const waves: string[][] = []
  while (done.size < tasks.length) {
    const wave = pickRunnable(tasks, { done, running: new Set<string>() })
    if (wave.length === 0) break // no progress (should not happen post-validation)
    waves.push(wave)
    for (const id of wave) done.add(id)
  }
  return waves
}

// Parse + validate + conflict-check + wave a raw manifest into an ExecutionPlan,
// or return every error in one pass. rawTasks is one JSON value per manifest file
// (the IO of reading the files lives in the tsx entrypoint, keeping this pure).
export function planManifest(rawTasks: unknown[], opts: PlanOptions = {}): PlanResult {
  const repo = opts.repo ?? DEFAULT_REPO
  const model = opts.model ?? DEFAULT_PHANTOM_MODEL

  const parsed: ParsedTask[] = []
  const errors: string[] = []
  rawTasks.forEach((raw, i) => {
    const res = parseManifestTask(raw)
    if (res.ok) parsed.push(res.task)
    else errors.push(...res.errors.map(e => `task[${i}]: ${e}`))
  })
  if (errors.length > 0) return { ok: false, errors }

  const cross = validateManifest(parsed)
  if (cross.errors.length > 0) return { ok: false, errors: cross.errors }

  const conflicts = findParallelConflicts(parsed)
  const waves = computeWaves(parsed)

  const tasks: PlannedPhantom[] = parsed.map(t => ({
    id: t.id,
    card: t.card,
    title: t.title,
    files_touched: t.files_touched,
    model,
    // The body is baked into the prompt here; PlannedPhantom carries the rendered
    // prompt, not the raw body, so the executor stays a thin launcher.
    prompt: buildPhantomPrompt(t, repo),
  }))

  return { ok: true, repo, schema: PHANTOM_RESULT_SCHEMA, tasks, waves, conflicts }
}

// Score finished phantom results against each task's declared files_touched
// globs (gate-readiness). Returns one decision per result, keyed by the result's
// `key` (== task id). A result whose key is unknown is scored against no globs,
// so any changed file counts as overrun (flagged, never auto-gated).
export function evaluatePhantomResults(
  results: PhantomResult[],
  tasks: Array<{ id: string; files_touched: string[] }>,
): Array<{ key: string; decision: GateDecision }> {
  const globsById = new Map(tasks.map(t => [t.id, t.files_touched]))
  return results.map(r => ({
    key: r.key,
    decision: evaluateGateReadiness(r, globsById.get(r.key) ?? []),
  }))
}
