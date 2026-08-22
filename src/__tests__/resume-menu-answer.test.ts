import { describe, it, expect } from 'vitest'
import { classifyResumePane } from '../web/agent-process.js'
import { detectPaneState } from '../pane-state.js'

// A6 (item4): the watchdog's answer_resume_prompt() polling logic, consolidated
// into the launcher. classifyResumePane is the pure decision; these tests pin it
// and self-validate the fixtures against detectPaneState.

const RESUME_MODAL = [
  '╭─ Resume from summary ─────────────────╮',
  '│ 1. Resume from summary (recommended)  │',
  '│ 2. Start fresh                        │',
  '╰───────────────────────────────────────╯',
  'Enter to confirm',
].join('\n')

// A realistic idle pane: a COMPLETE structural input box (two ─ separators
// framing a ❯ prompt) over the footer. Card d978f8bd makes the box the positive
// proof of a promptable surface, so the fixture must render it -- the earlier
// footer-string-only model ('> ' + footer, no box) no longer reads as idle, which
// is correct: a real active prompt always renders the box.
const SEP = '─'.repeat(60)
const IDLE_FOOTER = [
  SEP,
  '❯ ',
  SEP,
  '⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const BUSY_PANE = [
  '✻ Compacting conversation…',
  '  (esc to interrupt)',
].join('\n')

describe('classifyResumePane', () => {
  it('answers the resume-from-summary modal when it is up', () => {
    expect(classifyResumePane(RESUME_MODAL)).toBe('answer-resume')
  })

  it('reports ready when the active prompt footer is up', () => {
    // self-validate the fixture: detectPaneState must see this as idle
    expect(detectPaneState(IDLE_FOOTER)).toBe('idle')
    expect(classifyResumePane(IDLE_FOOTER)).toBe('ready')
  })

  it('waits when neither the modal nor the active prompt is up', () => {
    expect(detectPaneState(BUSY_PANE)).not.toBe('idle')
    expect(classifyResumePane(BUSY_PANE)).toBe('wait')
  })

  it('prioritises answering the modal even if an idle footer is also present', () => {
    // a stale footer in scrollback must not pre-empt answering the live modal
    const both = IDLE_FOOTER + '\n' + RESUME_MODAL
    expect(classifyResumePane(both)).toBe('answer-resume')
  })

  it('waits on an empty pane (nothing rendered yet)', () => {
    expect(classifyResumePane('')).toBe('wait')
  })
})
