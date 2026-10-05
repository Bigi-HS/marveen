import { describe, expect, it } from 'vitest'
import { classifyPane, type PaneClassifyState } from '../pane-classify-cli.js'

// Helpers to build pane fixtures with controlled scrollback vs tail
function withScrollback(scrollback: string, tail: string): string {
  return scrollback + '\n' + tail
}

// A tail-present idle footer that detectPaneState recognises as idle.
// Matches IDLE_FOOTER_RX: /bypass permissions on...|\? for shortcuts/
const IDLE_FOOTER = '\n? for shortcuts'

// Real limit-menu chrome (STRONG path: LIMIT_MENU_OPTION_RX).
const LIMIT_MENU_TAIL = `You've reached your usage limit
Stop and wait for limit to reset
Upgrade to Pro`

// Real survey modal header (FEEDBACK_MODAL_RX).
const SURVEY_TAIL = `How is Claude doing this session? (optional)
1. Amazing  2. Good  3. Meh  4. Bad`

// Real press-enter prompt (ENTER_STUCK_RX).
const ENTER_TAIL = `Compiling project...
Press Enter to continue`

// Login box chrome (LOGIN_BOX_ESC_RX + LOGIN_BOX_PASTE_RX).
const LOGIN_BOX_TAIL = `Open the URL in your browser
Esc to cancel
Paste code here:`

// ── G2 (limit) ──────────────────────────────────────────────────────────────

describe('G2 limit detection', () => {
  it('ADV-G2-1: "weekly limit" in scrollback prose -> NOT limit (FP root cause)', () => {
    // The old bare-substring matched *"weekly limit"* anywhere in pane_text.
    // The canonical TS detector scopes to tail-18 and requires STRONG menu chrome
    // or WEAK phrase+reset-time combo. Plain prose in scrollback must not trigger.
    const scrollback = Array.from({ length: 30 }, (_, i) =>
      i === 5 ? 'The weekly limit is 100 requests per day.' : `Line ${i}`,
    ).join('\n')
    expect(classifyPane(scrollback + IDLE_FOOTER)).not.toBe<PaneClassifyState>('limit')
  })

  it('ADV-G2-1b: "credit" and "budget" prose in scrollback -> NOT limit', () => {
    const scrollback = Array.from({ length: 30 }, (_, i) =>
      i === 3 ? 'Your credit balance and budget allocation have been updated.' : `Line ${i}`,
    ).join('\n')
    expect(classifyPane(scrollback + IDLE_FOOTER)).not.toBe<PaneClassifyState>('limit')
  })

  it('ADV-G2-2: real limit menu in tail-18 -> limit', () => {
    const scrollback = Array.from({ length: 20 }, (_, i) => `Scrollback line ${i}`).join('\n')
    expect(classifyPane(scrollback + '\n' + LIMIT_MENU_TAIL)).toBe<PaneClassifyState>('limit')
  })

  it('ADV-G2-3: STRONG menu option alone in tail -> limit (truncated-viewport path)', () => {
    const pane = 'Some content\nStop and wait for limit to reset\n'
    expect(classifyPane(pane)).toBe<PaneClassifyState>('limit')
  })
})

// ── G6 (survey) ──────────────────────────────────────────────────────────────

describe('G6 survey detection', () => {
  it('ADV-G6-1: survey modal in tail-10 -> survey', () => {
    const scrollback = Array.from({ length: 5 }, (_, i) => `Scrollback ${i}`).join('\n')
    expect(classifyPane(scrollback + '\n' + SURVEY_TAIL)).toBe<PaneClassifyState>('survey')
  })

  it('ADV-G6-2: survey phrase in scrollback only (>10 lines before) -> NOT survey (FP fix)', () => {
    // Dismissed modal scrolled away: phrase in first 2 lines, then 20 lines of output
    // pushes it more than FEEDBACK_MODAL_TAIL_LINES(10) above the end.
    const lines = [
      'How is Claude doing this session? (optional)',
      '1. Amazing  2. Good  3. Meh  4. Bad',
      ...Array.from({ length: 20 }, (_, i) => `Later output line ${i}`),
      IDLE_FOOTER,
    ]
    expect(classifyPane(lines.join('\n'))).not.toBe<PaneClassifyState>('survey')
  })

  it('ADV-G6-3: "survey-modal-recovery.js" filename in pane -> NOT survey (FP dimension 1)', () => {
    const pane = `Editing src/survey-modal-recovery.js\n> `
    expect(classifyPane(pane)).not.toBe<PaneClassifyState>('survey')
  })
})

// ── G1 (enter-stuck) ─────────────────────────────────────────────────────────

describe('G1 enter-stuck detection', () => {
  it('ADV-G1-1: "Press Enter" in tail-10 -> enter', () => {
    const scrollback = Array.from({ length: 5 }, (_, i) => `Scrollback ${i}`).join('\n')
    expect(classifyPane(scrollback + '\n' + ENTER_TAIL)).toBe<PaneClassifyState>('enter')
  })

  it('ADV-G1-1b: "press enter" case-insensitive -> enter', () => {
    expect(classifyPane('Some lines\npress enter to continue')).toBe<PaneClassifyState>('enter')
  })

  it('ADV-G1-2: "Press Enter" in scrollback only (>10 lines above tail) -> NOT enter (FP fix)', () => {
    // Enter-prompt in first line; then 20 output lines push it out of ENTER_TAIL_LINES(10).
    const lines = [
      'Press Enter to start the process.',
      ...Array.from({ length: 20 }, (_, i) => `Output line ${i}`),
      IDLE_FOOTER,
    ]
    expect(classifyPane(lines.join('\n'))).not.toBe<PaneClassifyState>('enter')
  })
})

// ── G3 (login) ───────────────────────────────────────────────────────────────

describe('G3 login detection', () => {
  it('login box in tail -> login', () => {
    const scrollback = Array.from({ length: 5 }, (_, i) => `Line ${i}`).join('\n')
    expect(classifyPane(scrollback + '\n' + LOGIN_BOX_TAIL)).toBe<PaneClassifyState>('login')
  })

  it('ADV-G3-1: login chrome in scrollback only (>10 lines above tail) -> NOT login (FP fix)', () => {
    // Login box scrolled away (agent resumed): chrome in first lines,
    // then 20 output lines push it out of LOGIN_BOX_TAIL_LINES(10).
    const lines = [
      ...LOGIN_BOX_TAIL.split('\n'),
      ...Array.from({ length: 20 }, (_, i) => `Output line ${i}`),
      IDLE_FOOTER,
    ]
    expect(classifyPane(lines.join('\n'))).not.toBe<PaneClassifyState>('login')
  })

  it('ADV-G3-2: ESC marker without PASTE_RX -> NOT login (partial-chrome FP)', () => {
    // Only one of the two required markers present (AND gate in detectsActiveLoginBox).
    const pane = 'Some content\nEsc to cancel\nMore output\n' + IDLE_FOOTER
    expect(classifyPane(pane)).not.toBe<PaneClassifyState>('login')
  })
})

// ── Priority ordering ────────────────────────────────────────────────────────

describe('priority ordering', () => {
  it('limit wins over survey when both present in tail', () => {
    const combined = LIMIT_MENU_TAIL + '\n' + SURVEY_TAIL
    expect(classifyPane(combined)).toBe<PaneClassifyState>('limit')
  })

  it('survey wins over enter when both present in tail', () => {
    const combined = SURVEY_TAIL + '\n' + ENTER_TAIL
    expect(classifyPane(combined)).toBe<PaneClassifyState>('survey')
  })
})

// ── Healthy states ────────────────────────────────────────────────────────────

describe('healthy states', () => {
  it('empty pane -> unknown', () => {
    expect(classifyPane('')).toBe<PaneClassifyState>('unknown')
    expect(classifyPane('   \n  ')).toBe<PaneClassifyState>('unknown')
  })

  it('non-CC pane (no input box) -> unknown (not a wedge state)', () => {
    // A shell prompt with no Claude Code structural input box -> unknown.
    // Key invariant: not classified as limit/survey/enter/login.
    const result = classifyPane('Normal output\n? for shortcuts')
    expect(result).not.toBe<PaneClassifyState>('limit')
    expect(result).not.toBe<PaneClassifyState>('survey')
    expect(result).not.toBe<PaneClassifyState>('enter')
    expect(result).not.toBe<PaneClassifyState>('login')
  })
})

// ── Fail-safe ────────────────────────────────────────────────────────────────

describe('fail-safe', () => {
  it('classifyPane never throws; returns unknown on bad input', () => {
    expect(() => classifyPane(null as unknown as string)).not.toThrow()
    expect(classifyPane(null as unknown as string)).toBe<PaneClassifyState>('unknown')
  })
})
