// Card 4e5e529a (E2), slice 4 (final): decide whether a finished phantom branch
// is auto-fileable to the Thor+Dave gate. Pure over the result record the runner
// already collected -- the git/IO that produces that record lives in the runner
// script; this is only the decision, so it is unit-tested directly.
//
// A branch is gate-ready iff it was based on the confirmed develop HEAD, has
// exactly one commit, left the main checkout clean, was pushed, typechecks and
// tests pass, AND every file it changed is covered by the task's declared
// files_touched globs (no overrun). Anything else is FLAGGED for human review,
// never auto-gated.

import { findOverrunFiles } from './manifest-guard.js'

// The phantom result schema fields this decision consumes (subset of the runner's
// full result object).
export interface PhantomResult {
  key: string
  baseConfirmed: boolean
  commitCount: number
  filesChanged: string[]
  typecheck: 'pass' | 'fail' | 'skipped' | string
  tests: string // "pass/fail/skipped + detail"
  mainCheckoutClean: boolean
  pushed: boolean
  blockers?: string
}

export interface GateDecision {
  gateReady: boolean
  blockers: string[]
  overrun: string[]
}

// The runner records `tests` as a free string ("pass/fail/skipped + detail");
// treat it as a pass only when it starts with "pass" (case/space-insensitive).
export function isTestPass(tests: string): boolean {
  return /^\s*pass/i.test(tests)
}

// Evaluate one finished phantom result against its declared files_touched globs.
// Collects ALL blockers so the human report is complete in one pass.
export function evaluateGateReadiness(result: PhantomResult, declaredGlobs: string[]): GateDecision {
  const blockers: string[] = []

  if (!result.baseConfirmed) blockers.push('base not confirmed against develop HEAD')
  if (result.commitCount !== 1) blockers.push(`expected exactly 1 commit, got ${result.commitCount}`)
  if (!result.mainCheckoutClean) blockers.push('main checkout dirty (source drift after work)')
  if (!result.pushed) blockers.push('branch not pushed')
  if (result.typecheck !== 'pass') blockers.push(`typecheck not passing (${result.typecheck})`)
  if (!isTestPass(result.tests)) blockers.push(`tests not passing (${result.tests})`)

  const overrun = findOverrunFiles(result.filesChanged, declaredGlobs)
  if (overrun.length > 0) {
    blockers.push(`changed files outside declared files_touched (overrun): ${overrun.join(', ')}`)
  }

  const runnerBlockers = (result.blockers ?? '').trim()
  if (runnerBlockers.length > 0) blockers.push(`runner-reported blocker: ${runnerBlockers}`)

  return { gateReady: blockers.length === 0, blockers, overrun }
}
