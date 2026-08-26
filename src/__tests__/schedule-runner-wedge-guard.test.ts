// Adversarial fixture set for the sendPromptToSession verdict guard in
// schedule-runner.ts (card ENG-089 / 3e5c2914 Part B).
//
// Context: noa-scheduler.ts received the empty-composer check + submit-verify
// + escalation in PR #516 (3e5c2914). schedule-runner.ts has a parallel
// attemptFireTask() that shares the same sendPromptToSession injection path
// but was left unguarded by minimal-diff principle at the time.
//
// NOTE: attemptFireTask is dead code post-A4 (sweep moved to noa-scheduler.ts;
// schedule-runner.ts re-exports startScheduleRunner from noa-scheduler.js).
// The guard is applied so that if the path is ever revived, it already has the
// correct semantics. We verify the pattern exists in the source text because
// the function is private and cannot be reached through the public API.
//
// The four adversarial property claims mirror noa-scheduler.test.ts section
// 'runSweepTick: parked (un-submitted) prompt':
//   F1. parked verdict: appendTaskRun is NOT on the parked branch
//   F2. parked verdict: returns 'parked', not 'fired'
//   F3. unknown verdict: re-probes via capturePane + detectPaneState
//   F4. unknown + idle re-probe: falls through to appendTaskRun (fires)

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

// Locate the verdict-guard block: starts at "const verdict = sendPromptToSession"
// and ends just before "appendTaskRun(task.name" on the happy path.
const VERDICT_ASSIGN = "const verdict = sendPromptToSession(session, fullPrompt)"
const APPEND_TASK_RUN = "appendTaskRun(task.name, agentName)"

describe('schedule-runner.ts sendPromptToSession verdict guard (card ENG-089)', () => {
  it('F1: parked branch does NOT call appendTaskRun (recorded run without delivery = freeze)', () => {
    // Find the parked handler block.
    const parkedStart = SRC.indexOf("if (verdict === 'parked')")
    expect(parkedStart).toBeGreaterThan(0)

    // Find the closing brace of the parked if-block (return 'parked').
    const parkedReturn = SRC.indexOf("return 'parked'", parkedStart)
    expect(parkedReturn).toBeGreaterThan(parkedStart)

    // The first appendTaskRun after the verdict assign must come AFTER the
    // parked block closes -- appendTaskRun must not be reachable on the
    // parked path.
    const verdictIdx = SRC.indexOf(VERDICT_ASSIGN)
    expect(verdictIdx).toBeGreaterThan(0)
    const appendIdx = SRC.indexOf(APPEND_TASK_RUN, verdictIdx)
    expect(appendIdx).toBeGreaterThan(0)

    // appendTaskRun comes AFTER the parked return, so it is on the fall-through
    // (submitted/idle-reprobe) path only.
    expect(appendIdx).toBeGreaterThan(parkedReturn)
  })

  it('F2: parked branch returns "parked", not "fired"', () => {
    const parkedHandlerIdx = SRC.indexOf("if (verdict === 'parked')")
    expect(parkedHandlerIdx).toBeGreaterThan(0)
    // The return statement following the parked log must be 'parked'.
    const firstReturn = SRC.indexOf('return', parkedHandlerIdx)
    const returnSnippet = SRC.slice(firstReturn, firstReturn + 30)
    expect(returnSnippet).toMatch(/return 'parked'/)
  })

  it('F3: unknown verdict triggers a capturePane re-probe before deciding', () => {
    const unknownHandlerIdx = SRC.indexOf("if (verdict === 'unknown')")
    expect(unknownHandlerIdx).toBeGreaterThan(0)

    // capturePane must appear inside the unknown handler before detectPaneState.
    const capturePaneIdx = SRC.indexOf('capturePane(session)', unknownHandlerIdx)
    expect(capturePaneIdx).toBeGreaterThan(unknownHandlerIdx)

    const detectIdx = SRC.indexOf('detectPaneState', unknownHandlerIdx)
    expect(detectIdx).toBeGreaterThan(unknownHandlerIdx)
  })

  it('F4: idle re-probe on unknown falls through to appendTaskRun (fires rather than parked)', () => {
    // After the unknown handler, the idle branch must have a comment or
    // fall-through annotation, NOT an early return.
    const unknownHandlerIdx = SRC.indexOf("if (verdict === 'unknown')")
    expect(unknownHandlerIdx).toBeGreaterThan(0)

    const idleBranchIdx = SRC.indexOf("reprobeState === 'idle'", unknownHandlerIdx)
    expect(idleBranchIdx).toBeGreaterThan(unknownHandlerIdx)

    // The idle branch should NOT have 'return' before appendTaskRun.
    // Find the idle branch body end by looking for the else-if.
    const elseIfTypingIdx = SRC.indexOf("reprobeState === 'typing'", idleBranchIdx)
    expect(elseIfTypingIdx).toBeGreaterThan(idleBranchIdx)

    const idleBranchBody = SRC.slice(idleBranchIdx, elseIfTypingIdx)
    // Idle branch falls through: no 'return' inside it.
    expect(idleBranchBody).not.toMatch(/\breturn\b/)
  })
})
