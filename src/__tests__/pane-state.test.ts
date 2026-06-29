import { describe, it, expect } from 'vitest'
import {
  detectPaneState,
  detectsThinkingBlockError,
  detectsUsageLimitMenu,
  detectsStalledIdle,
  isReadyForPrompt,
  isActivelyWorking,
  shouldRetrySubmit,
  shouldClearTruncatedPreamble,
  decideSubmitFollowup,
  decidePaneErrorAlert,
  stuckInputSignature,
  pendingPasteSignature,
  decideStuckInputRecovery,
  isQuiescentlyIdle,
  computeAgentActivityLabel,
  CLAUDE_SPINNER_LABELS,
  type StuckInputState,
  type QuiescenceSample,
} from '../pane-state.js'

// Realistic pane fixtures modelled on actual `tmux capture-pane -p`
// output from shipping Claude Code builds. Whitespace and box-drawing
// characters (U+2500 ─, U+276F ❯, U+23F5 ⏵) preserved exactly so the
// regex matches exercise the same byte sequences they would in prod.

const SEP = '─'.repeat(80)

// Fixed wall-clock instants (epoch ms; Europe/Budapest = CEST +02:00 in June) for
// the usage-limit staleness guard (card c7987f52). The WEAK-path classification
// (limit phrase + reset time) trips only while the reset clock-time is still
// AHEAD of "now"; a reset already PAST (> grace) is a stale leftover banner that
// must NOT pin an idle pane busy. These make the formerly-implicit "now" explicit
// so the assertions are deterministic regardless of the real run clock.
const NOW_BEFORE_RESETS = Date.parse('2026-06-28T14:00:00+02:00') // 14:00 -- before "3pm"/"7:40pm"
const NOW_AFTER_RESETS = Date.parse('2026-06-28T20:00:00+02:00') // 20:00 -- past "6:50pm"/"3pm"/"7:40pm"

const IDLE_BYPASS = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const IDLE_STRICT = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ? for shortcuts',
].join('\n')

const BUSY_FULL_FOOTER = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

// The smoke-test bug scenario: spinner rendered, but the footer is still
// in its one-frame idle state before `· esc to interrupt` is appended.
const BUSY_FOOTER_FRAME_GAP = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Spinner label missing (older/newer Claude Code build). Only the
// token-count pattern is present. Must still classify as busy.
const BUSY_TOKENS_ONLY = [
  '✶ (4s · ↓ 120 tokens)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Tool-use summary lines persist in the scrollback AFTER a turn ends --
// Claude Code does not overwrite them. Including them as busy signals
// would classify an otherwise idle agent as busy forever, starving
// the scheduler. This fixture models the post-turn idle state: the tool
// summary is on screen but no spinner, no tokens, no esc-to-interrupt.
const IDLE_AFTER_TOOL_USE = [
  '  Searched for 3 patterns, listed 4 directories (ctrl+o to expand)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Real busy-with-tool-use: spinner line present alongside the tool summary.
const BUSY_TOOL_USE_ACTIVE = [
  '  Searched for 3 patterns, listed 4 directories (ctrl+o to expand)',
  '✢ Combobulating… (12s · ↓ 480 tokens)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

const TYPING_PARKED = [
  '',
  SEP,
  '❯ Valami amit a felhasznalo elkezdett geppelni, meg nem kuldte el',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const PENDING_PASTE = [
  '',
  SEP,
  '❯ [Pasted text #1 +234 chars]',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A paste placeholder still parked AND a live spinner rendering: the turn
// is genuinely processing the pasted payload. Must NOT be read as a stale
// paste stall (the recovery Enter would land mid-turn).
const PENDING_PASTE_WITH_SPINNER = [
  '✢ Combobulating… (12s · ↓ 480 tokens)',
  '',
  SEP,
  '❯ [Pasted text #1 +234 chars]',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

// The paste burst is still arriving: a second placeholder appears / the
// char count grows between polls. The signature must change so the
// confirm window restarts and no premature recovery fires.
const PENDING_PASTE_GROWN = [
  '',
  SEP,
  '❯ [Pasted text #1 +234 chars] [Pasted text #2 +88 chars]',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A paste placeholder parked in the box AND a usage-limit footer in the
// tail. The limit modal is a real blocking surface, not a swallowed-Enter
// paste stall -- recovery must not fire (the usage-limit handlers own it).
const PENDING_PASTE_WITH_LIMIT = [
  '',
  SEP,
  '❯ [Pasted text #1 +234 chars]',
  SEP,
  "  You've reached your usage limit · resets at 3pm",
].join('\n')

// A `[Pasted text]` echo sitting in scrollback above the live (empty)
// input box. Not live parked input -- must not be a paste-stall signal.
const PENDING_PASTE_IN_SCROLLBACK = [
  '  ❯ [Pasted text #9 +12 chars] from an old turn',
  '  output of that turn',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Historical ❯ above the separators (scrollback). Must NOT count as
// parked input -- the input box is strictly the region between the two
// most recent separators.
const IDLE_WITH_SCROLLBACK_CARET = [
  '  ❯ some old echoed command from scrollback',
  '  output of that command',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A pane that is not Claude Code at all (regular shell).
const NON_CLAUDE = [
  'user@host ~ $ ls',
  'README.md  src/  test/',
].join('\n')

// Background-shells footer variant. Claude Code rewrites the bypass-mode
// footer when the session has one or more BashTool background shells
// running: the "(shift+tab to cycle)" hint is replaced with the
// "· N shells · ctrl+t to hide tasks · ↓ to manage" indicator. The pane
// is still idle and must accept a new prompt -- otherwise inter-agent
// messages and scheduled tasks pile up in pending forever for any agent
// that polls (gh run list, watchers, etc.) in the background.
const IDLE_BACKGROUND_SHELLS = [
  '  85 tasks (84 done, 1 in progress, 0 open)',
  '   … +80 completed',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 3 shells · ctrl+t to hide tasks · ↓ to manage',
].join('\n')

// Same variant with a single shell (singular form). Defensive: the regex
// must accept both "shell" and "shells" so a 1-shell session is not stuck.
const IDLE_BACKGROUND_ONE_SHELL = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 1 shell · ctrl+t to hide tasks · ↓ to manage',
].join('\n')

// Background-shells footer with the tasks panel HIDDEN. When the
// operator (or the agent) presses ctrl+t to hide the tasks panel,
// Claude Code drops the "ctrl+t to hide tasks" segment and renders a
// shorter footer: "· N shells · ↓ to manage". The pane is still idle;
// the only difference is that the toggle hint is gone because the panel
// it would toggle is already hidden. Observed in production on a sub-
// agent session where the operator had hidden the tasks panel.
const IDLE_BACKGROUND_SHELLS_HIDDEN = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 3 shells · ↓ to manage',
].join('\n')

// Same hidden-tasks variant with a single shell (singular form).
// Defensive: covers the corner where a session has exactly one
// background shell AND the tasks panel is hidden, so neither the
// plural form nor the ctrl+t segment is present.
const IDLE_BACKGROUND_ONE_SHELL_HIDDEN = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
].join('\n')

// Wedged thinking-block API error. An assistant turn ended with the
// 400 about thinking blocks that "cannot be modified"; the pane shows
// the tool-output chrome (`⎿  API Error: ...`), a past-tense thinking
// stamp, an empty input box and the idle footer. The U+23BF result
// glyph and the full phrase are reproduced exactly so the regex sees
// the same bytes it would in prod. Sanitised: no internal names/paths.
const ERROR_THINKING_BLOCK = [
  '  ⎿  API Error: 400 messages.55.content.19: `thinking` or `redacted_thinking` blocks in the latest assistant message',
  '      cannot be modified. These blocks must remain as they were in the original response.',
  '',
  '✻ Sauteed for 1s',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A message body that QUOTES "API Error 400" in prose (an instruction
// to report if the error recurs). No `⎿  API Error: <num>` chrome and
// no "cannot be modified" phrase -- must NOT be read as a wedged error.
const ERROR_ECHO_IN_MESSAGE = [
  '  HA a session-history korrupt es ismet API Error 400 jon a feldolgozas',
  '  elejen, AZONNAL jelezd vissza inter-agent uzenetben.',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A reply that quotes the FULL phrase ("thinking ... cannot be
// modified") in prose, e.g. a bug analysis, but WITHOUT the
// `⎿  API Error: <num>` chrome glyph. The chrome guard must keep this
// out of the 'error' class.
const ERROR_FULL_PHRASE_PROSE = [
  '  A hiba lenyege: a thinking vagy redacted_thinking blocks cannot be',
  '  modified ket API-hivas kozott. Ezt most csak elemzem, nem elo hiba.',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// An old error far up in scrollback (above the live tail), with a fresh
// idle turn below it. The position scope must ignore the stale error so
// a recovered session is not stuck classified as 'error'.
const ERROR_DEEP_SCROLLBACK = [
  '  ⎿  API Error: 400 messages.55.content.19: `thinking` blocks cannot be modified.',
  ...Array(24).fill('  (normal output line after the session recovered)'),
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Error chrome present BUT a live spinner is also rendered: the turn is
// running again, not wedged. The busy guard must win so we do not stop
// injecting into a session that is actually working.
const ERROR_DURING_BUSY = [
  '  ⎿  API Error: 400 messages.55.content.19: `thinking` blocks cannot be modified.',
  '✻ Combobulating… (12s · ↓ 480 tokens)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

// A BENIGN chrome error (429) on one line AND an unrelated "thinking ...
// cannot be modified" prose several lines below it (outside the chrome
// block). The guards are required WITHIN one chrome block, so this must
// NOT be flagged -- otherwise a healthy session that hits a rate limit
// and elsewhere mentions the phrase would be wrongly reset.
const ERROR_DECOUPLED_BENIGN = [
  '  ⎿  API Error: 429 overloaded_error: server busy, retrying',
  '  retry succeeded, continuing the task',
  '  finished that step',
  '',
  '  Note: the thinking-block error is when a block cannot be modified.',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A real wedged error with a STRAY footer-looking line ("? for
// shortcuts") quoted higher up in scrollback. The footer must be found
// from the bottom, otherwise the scope locks onto the stray line and the
// real error below it is missed (false negative).
const ERROR_WITH_STRAY_FOOTER_ABOVE = [
  '  Use the ? for shortcuts hint mentioned in the docs',
  '  (a scrollback message that quotes help text)',
  '  ⎿  API Error: 400 messages.55.content.19: `thinking` or `redacted_thinking` blocks in the latest assistant message',
  '      cannot be modified. These blocks must remain as they were in the original response.',
  '✻ Sauteed for 1s',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Narrow terminal: the long error message wraps so "cannot be modified"
// lands on the 4th line of the chrome block (chrome + 3 continuations).
// A 3-line window would miss it (false negative); the 4-line block
// catches it. The thinking kind is on the chrome line, redacted_thinking
// on the 2nd, the phrase on the 4th.
const ERROR_NARROW_WRAP = [
  '  ⎿  API Error: 400 messages.55.content.19: `thinking`',
  '      or `redacted_thinking` blocks in the latest assistant',
  '      message. These response',
  '      blocks cannot be modified and must remain unchanged.',
  '✻ Sauteed for 1s',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

describe('detectPaneState', () => {
  it('returns unknown for empty input', () => {
    expect(detectPaneState('')).toBe('unknown')
    expect(detectPaneState('   \n\n  ')).toBe('unknown')
  })

  it('detects idle on bypass-mode footer with empty input box', () => {
    expect(detectPaneState(IDLE_BYPASS)).toBe('idle')
  })

  it('detects idle on strict-mode footer ("? for shortcuts")', () => {
    expect(detectPaneState(IDLE_STRICT)).toBe('idle')
  })

  it('detects idle when the footer shows the multi-shell indicator', () => {
    // Regression: Claude Code rewrites "(shift+tab to cycle)" to
    // "· N shells · ctrl+t to hide tasks · ↓ to manage" when the session
    // has BashTool background shells running. The old strict regex did
    // not match this variant, so any session with a background poll
    // was classified 'unknown' and never received inter-agent messages.
    expect(detectPaneState(IDLE_BACKGROUND_SHELLS)).toBe('idle')
  })

  it('detects idle when the footer shows the singular "1 shell" form', () => {
    // The footer uses the singular "1 shell" (not "1 shells") for a
    // single background shell. Split from the multi-shell test so a
    // future regression on either form fails with a precise signal.
    expect(detectPaneState(IDLE_BACKGROUND_ONE_SHELL)).toBe('idle')
  })

  it('detects idle when the tasks panel is HIDDEN (no "ctrl+t" segment)', () => {
    // Claude Code drops the "ctrl+t to hide tasks" segment when the
    // tasks panel is already hidden, leaving "· N shells · ↓ to manage"
    // as the only suffix. The pane is still idle, just with a shorter
    // footer. The previous regex only matched the "ctrl+t" form, so
    // sessions with the tasks panel hidden were classified 'unknown'
    // and inter-agent messages stalled until the next manual toggle.
    expect(detectPaneState(IDLE_BACKGROUND_SHELLS_HIDDEN)).toBe('idle')
    expect(detectPaneState(IDLE_BACKGROUND_ONE_SHELL_HIDDEN)).toBe('idle')
  })

  it('classifies a complete input box as idle even when the footer string is unrecognised', () => {
    // Structural contract (d3339db9): a pane with a COMPLETE input box (two
    // box separators framing a ❯ prompt) at the bottom IS a ready Claude
    // Code surface, regardless of the footer-slot text. The footer rotates
    // onboarding tips and sometimes drops the "bypass permissions on"
    // segment, so footer-STRING strictness (the prior gate) silently
    // dropped messages to idle channel-less agents. A truncated
    // "· 1 shell" footer over a complete box is one such case: the box is
    // rendered and empty, so the pane is ready.
    const truncatedFooter = [
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on · 1 shell',
    ].join('\n')
    expect(detectPaneState(truncatedFooter)).toBe('idle')
  })

  it('still classifies a non-surface (footer-looking text, no input box) as unknown', () => {
    // Conservatism preserved for the genuine negative: a footer-looking
    // string with NO complete input box is not a promptable surface, so we
    // must not deliver a prompt into it.
    const noBox = [
      '  some log output',
      '  ⏵⏵ bypass permissions on · 1 shell',
      '  more scrollback, no box separators here',
    ].join('\n')
    expect(detectPaneState(noBox)).toBe('unknown')
  })

  it('takes the bottom-most box: a quoted box in scrollback cannot spoof readiness', () => {
    // The prior footer-string concern (a "bypass permissions on · 1 shell"
    // echo in scrollback faking a live footer) is now handled structurally:
    // findInputBoxBounds scans from the BOTTOM, so a ─/❯/─ block echoed
    // higher up in scrollback never wins over the real live box below it.
    // Here the scrollback box holds parked text but the live box is empty
    // -> idle (NOT typing), proving the live box is the one inspected.
    const pane = [
      SEP,
      '❯ quoted parked text from an old echoed message',
      SEP,
      '  some intervening tool output',
      SEP,
      '❯ ',
      SEP,
      '  gh auth login · ← for agents',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('detects busy when "esc to interrupt" footer marker is present', () => {
    expect(detectPaneState(BUSY_FULL_FOOTER)).toBe('busy')
  })

  it('detects busy even when the footer frame-gap hides "esc to interrupt"', () => {
    // Regression for the smoke-test-11-10 bug: spinner + tokens visible,
    // footer still shows plain idle. Old single-regex detector said idle
    // (false positive). New detector catches via BUSY_INDICATORS.
    expect(detectPaneState(BUSY_FOOTER_FRAME_GAP)).toBe('busy')
  })

  it('detects busy from the token-count pattern alone (unknown spinner label)', () => {
    // A Claude Code release could rename "Combobulating" to anything. The
    // (Ns · ↓N tokens) pattern is the load-bearing fallback.
    expect(detectPaneState(BUSY_TOKENS_ONLY)).toBe('busy')
  })

  it('detects busy when a tool-use summary is paired with a live spinner', () => {
    expect(detectPaneState(BUSY_TOOL_USE_ACTIVE)).toBe('busy')
  })

  it('detects error when wedged on the thinking-block 400', () => {
    // The wedged state: idle footer (turn finished) + past-tense
    // thinking stamp, no live busy signal, but the live tail shows the
    // `⎿  API Error: ... thinking ... cannot be modified` output. Old
    // detector said 'idle' here, so the scheduler kept injecting doomed
    // prompts. Must now be 'error' so isReadyForPrompt() returns false.
    expect(detectPaneState(ERROR_THINKING_BLOCK)).toBe('error')
  })

  it('does NOT classify a prose "API Error 400" mention as error', () => {
    // A message body quoting "API Error 400" (an instruction to report
    // recurrence) has no `⎿  API Error: <num>` chrome and no
    // "cannot be modified" phrase. Must stay idle.
    expect(detectPaneState(ERROR_ECHO_IN_MESSAGE)).toBe('idle')
  })

  it('does NOT classify the full phrase in prose (no chrome) as error', () => {
    // A bug-analysis reply quoting "thinking ... cannot be modified" in
    // prose, without the tool-output chrome glyph, must not trip the
    // detector. The chrome guard is what discriminates a real wedged
    // turn from a quote.
    expect(detectPaneState(ERROR_FULL_PHRASE_PROSE)).toBe('idle')
  })

  it('does NOT classify a stale error in deep scrollback as error', () => {
    // Once a session recovers, its old error scrolls up out of the live
    // tail. The position scope must ignore it so a healthy session is
    // not stuck flagged. Below the stale error the pane is plainly idle.
    expect(detectPaneState(ERROR_DEEP_SCROLLBACK)).toBe('idle')
  })

  it('prefers busy over error when a live spinner is rendered', () => {
    // Error chrome on screen but the turn is running again (spinner +
    // token tail). The busy guard precedes the error guard so we do not
    // stop injecting into a session that is actually working.
    expect(detectPaneState(ERROR_DURING_BUSY)).toBe('busy')
  })

  it('does NOT flag a benign chrome + decoupled phrase as error', () => {
    // A 429 chrome on one line and an unrelated "cannot be modified"
    // prose several lines below (outside the chrome block) must not
    // AND-combine into a false positive. This is the per-block guard.
    expect(detectPaneState(ERROR_DECOUPLED_BENIGN)).toBe('idle')
  })

  it('detects error even when a stray footer line sits in scrollback', () => {
    // The footer is found from the bottom, so a "? for shortcuts" string
    // quoted higher up does not steal the scope from the real wedged
    // error sitting just above the live footer.
    expect(detectPaneState(ERROR_WITH_STRAY_FOOTER_ABOVE)).toBe('error')
  })

  it('detects error when a narrow terminal wraps the message onto 4 lines', () => {
    // The phrase "cannot be modified" wraps to the 4th line of the
    // chrome block. The 4-line block window must still catch it.
    expect(detectPaneState(ERROR_NARROW_WRAP)).toBe('error')
  })

  it('does NOT classify idle-with-stale-tool-use-scrollback as busy', () => {
    // Tool-use summary lines survive into the scrollback after the turn
    // ends. Classifying them as busy would starve the scheduler after
    // any agent's tool call. Only active-turn signals (spinner, tokens,
    // esc-to-interrupt, footer-scoped) count.
    expect(detectPaneState(IDLE_AFTER_TOOL_USE)).toBe('idle')
  })

  it('detects typing when text is parked in the input box', () => {
    expect(detectPaneState(TYPING_PARKED)).toBe('typing')
  })

  it('merges typing into busy when mergeTypingAsBusy is set', () => {
    expect(detectPaneState(TYPING_PARKED, { mergeTypingAsBusy: true })).toBe('busy')
  })

  describe('ghost-text cursor guard (card c8d13cc0)', () => {
    // The TUI draws a dim autosuggestion into an EMPTY composer to the RIGHT of
    // the cursor; `capture-pane -p` strips the dim attribute so it is
    // byte-identical to a real draft. Without the cursor, PARKED_INPUT_RX reads
    // the suggestion as parked input -> 'typing', and an idle agent becomes
    // permanently undeliverable (the delivery deadlock). The cursor column is
    // the version-independent discriminator: real typed text sits to the LEFT
    // of the cursor, the suggestion is drawn to the RIGHT.

    // ❯(col0) + NBSP(col1) + suggestion 'merge PR #283' starting at col2.
    // Prompt line is row 2; the suggestion's first glyph is column 2.
    const GHOST_SUGGESTION = [
      '',
      SEP,
      '❯ merge PR #283',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    const GHOST_CURSOR = { x: 2, y: 2 }

    // A real typed draft: 'git status' typed, cursor AFTER the text.
    // ❯(0) space(1) g(2) ... 'git status' is 10 chars -> caret at col 12.
    const REAL_DRAFT = [
      '',
      SEP,
      '❯ git status',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    const REAL_CURSOR = { x: 12, y: 2 }

    // Ghost suggestion AND a live spinner: a turn is genuinely running.
    const GHOST_WITH_SPINNER = [
      '✢ Combobulating… (3s · ↓ 1.2k tokens)',
      '',
      SEP,
      '❯ merge PR #283',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')

    it('FP: a ghost suggestion (cursor at suggestion start) is idle', () => {
      expect(detectPaneState(GHOST_SUGGESTION, { cursor: GHOST_CURSOR })).toBe('idle')
    })

    it('FN (critical): a real typed draft (cursor after text) stays typing', () => {
      expect(detectPaneState(REAL_DRAFT, { cursor: REAL_CURSOR })).toBe('typing')
    })

    it('OC: a spinner with a ghost suggestion stays busy (busy guard wins)', () => {
      expect(detectPaneState(GHOST_WITH_SPINNER, { cursor: GHOST_CURSOR })).toBe('busy')
    })

    it('without cursor info a ghost line keeps the safe legacy state (typing)', () => {
      expect(detectPaneState(GHOST_SUGGESTION)).toBe('typing')
    })

    it('a cursor not on the prompt row leaves a ghost line as typing (safe)', () => {
      expect(detectPaneState(GHOST_SUGGESTION, { cursor: { x: 2, y: 0 } })).toBe('typing')
    })
  })

  it('treats a pending-paste placeholder as busy', () => {
    expect(detectPaneState(PENDING_PASTE)).toBe('busy')
  })

  it('does NOT confuse a historical ❯ in scrollback for a parked input', () => {
    expect(detectPaneState(IDLE_WITH_SCROLLBACK_CARET)).toBe('idle')
  })

  it('returns unknown for a pane that is not a Claude Code surface', () => {
    expect(detectPaneState(NON_CLAUDE)).toBe('unknown')
  })

  describe('CLAUDE_SPINNER_LABELS (card be2bebce)', () => {
    it('is exported and non-empty', () => {
      expect(Array.isArray(CLAUDE_SPINNER_LABELS)).toBe(true)
      expect(CLAUDE_SPINNER_LABELS.length).toBeGreaterThan(0)
    })

    it('contains no duplicates', () => {
      const set = new Set(CLAUDE_SPINNER_LABELS)
      expect(set.size).toBe(CLAUDE_SPINNER_LABELS.length)
    })

    it('each label is a non-empty string', () => {
      for (const label of CLAUDE_SPINNER_LABELS) {
        expect(typeof label).toBe('string')
        expect(label.length).toBeGreaterThan(0)
      }
    })

    it('every label in the test list is in CLAUDE_SPINNER_LABELS', () => {
      // The it.each list below should be a subset of the exported constant.
      const known = ['Thinking', 'Pondering', 'Beaming', 'Noodling', 'Cogitating']
      for (const name of known) {
        expect(CLAUDE_SPINNER_LABELS).toContain(name)
      }
    })
  })

  it.each([
    'Pondering…',
    'Beaming…',
    'Thinking…',
    'Reticulating…',
    'Configuring…',
    'Noodling…',
    'Ruminating…',
    'Percolating…',
    'Cogitating…',
    'Deliberating…',
    'Contemplating…',
    'Musing…',
    'Brewing…',
    'Synthesizing…',
    'Distilling…',
    'Refining…',
    'Simmering…',
    'Crafting…',
    'Formulating…',
    'Consulting…',
    'Unfurling…',
    'Unspooling…',
    'Unraveling…',
  ])('matches a busy spinner label paired with the runtime tail: %s', (label) => {
    // The label regex requires the `(Ns · ↓` tail on the same line so
    // prose like a Markdown heading `# Thinking…` does not false-positive.
    const snap = [
      `✢ ${label} (3s · ↓ 42 tokens)`,
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(snap)).toBe('busy')
  })

  it('does NOT classify a bare spinner-label word as busy (Markdown heading in reply text)', () => {
    // Regression: spinner labels followed by U+2026 ellipsis must not
    // false-positive on prose that happens to contain the word.
    // Without the `(Ns · ↓` tail requirement, any of these would stall
    // the scheduler forever once they landed in scrollback.
    const snaps = [
      '# Thinking…',
      'Step 1: Crafting… the plan',
      'Beaming… a message through the router',
    ]
    for (const prose of snaps) {
      const snap = [
        prose,
        SEP,
        '❯ ',
        SEP,
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n')
      expect(detectPaneState(snap)).toBe('idle')
    }
  })

  it('busy indicator wins over a visible idle footer', () => {
    // Both signals present: spinner says busy, footer says idle. Caller
    // must trust busy (it's a superset constraint).
    const snap = [
      '✢ Combobulating… (7s · ↓ 80 tokens)',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(snap)).toBe('busy')
  })

  it('does not match the token-count pattern in unrelated numeric text', () => {
    const snap = [
      'Some unrelated log line: latency 5s, count 42',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(snap)).toBe('idle')
  })

  it('footer alone with no input box -> unknown (card d978f8bd: positive affordance required)', () => {
    const snap = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
    // RE-POINTED by the default-flip (was 'idle'): a recognised footer with NO
    // structural input box is no longer promptable. The box scrolled off / never
    // rendered, so there is no proven affordance to inject into -> 'unknown'.
    expect(detectPaneState(snap)).toBe('unknown')
  })

  it('footer with only one separator (incomplete box) -> unknown (card d978f8bd)', () => {
    // RE-POINTED (was 'idle'): one separator is not a complete input box
    // (findInputBoxBounds needs two framing a ❯). Without the proven affordance
    // the fail-safe default is not-ready, not the optimistic idle fall-through.
    const snap = [
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(snap)).toBe('unknown')
  })
})

describe('isReadyForPrompt', () => {
  it('is true only when state === idle', () => {
    expect(isReadyForPrompt(IDLE_BYPASS)).toBe(true)
    expect(isReadyForPrompt(IDLE_STRICT)).toBe(true)
    expect(isReadyForPrompt(IDLE_BACKGROUND_SHELLS)).toBe(true)
    expect(isReadyForPrompt(IDLE_BACKGROUND_ONE_SHELL)).toBe(true)
    expect(isReadyForPrompt(IDLE_BACKGROUND_SHELLS_HIDDEN)).toBe(true)
    expect(isReadyForPrompt(IDLE_BACKGROUND_ONE_SHELL_HIDDEN)).toBe(true)
    expect(isReadyForPrompt(BUSY_FULL_FOOTER)).toBe(false)
    expect(isReadyForPrompt(BUSY_FOOTER_FRAME_GAP)).toBe(false)
    expect(isReadyForPrompt(TYPING_PARKED)).toBe(false)
    expect(isReadyForPrompt(PENDING_PASTE)).toBe(false)
    expect(isReadyForPrompt(NON_CLAUDE)).toBe(false)
    expect(isReadyForPrompt('')).toBe(false)
    // A wedged thinking-block error is not idle, so it is not ready --
    // this is what stops the router/scheduler injecting doomed prompts.
    expect(isReadyForPrompt(ERROR_THINKING_BLOCK)).toBe(false)
  })
})

describe('computeAgentActivityLabel (card edf73bd7 F2)', () => {
  it('maps a stopped agent to "stopped" regardless of pane', () => {
    expect(computeAgentActivityLabel(false, null)).toBe('stopped')
    expect(computeAgentActivityLabel(false, IDLE_STRICT)).toBe('stopped')
    expect(computeAgentActivityLabel(false, BUSY_FULL_FOOTER)).toBe('stopped')
  })

  it('maps a running agent with no capturable pane to "unknown"', () => {
    expect(computeAgentActivityLabel(true, null)).toBe('unknown')
  })

  it('maps busy/typing panes to "working"', () => {
    expect(computeAgentActivityLabel(true, BUSY_FULL_FOOTER)).toBe('working')
    expect(computeAgentActivityLabel(true, BUSY_TOKENS_ONLY)).toBe('working')
    expect(computeAgentActivityLabel(true, TYPING_PARKED)).toBe('working')
  })

  it('maps an idle pane to "idle"', () => {
    expect(computeAgentActivityLabel(true, IDLE_STRICT)).toBe('idle')
    expect(computeAgentActivityLabel(true, IDLE_BYPASS)).toBe('idle')
  })

  it('passes through error/unknown pane states verbatim', () => {
    expect(computeAgentActivityLabel(true, ERROR_THINKING_BLOCK)).toBe('error')
    expect(computeAgentActivityLabel(true, NON_CLAUDE)).toBe('unknown')
  })

  it('is the single source of truth shared with the /api/agents/activity route', () => {
    // The route previously inlined this exact mapping; both now call this helper.
    // Parity spot-check: the four enum branches a running agent can take.
    const running = true
    expect(computeAgentActivityLabel(running, BUSY_FULL_FOOTER)).toBe('working')
    expect(computeAgentActivityLabel(running, IDLE_STRICT)).toBe('idle')
    expect(computeAgentActivityLabel(running, ERROR_THINKING_BLOCK)).toBe('error')
    expect(computeAgentActivityLabel(running, null)).toBe('unknown')
  })
})

describe('detectsThinkingBlockError', () => {
  it('is true on the wedged thinking-block 400 pane', () => {
    expect(detectsThinkingBlockError(ERROR_THINKING_BLOCK)).toBe(true)
  })

  it('is false on a healthy idle pane', () => {
    expect(detectsThinkingBlockError(IDLE_BYPASS)).toBe(false)
    expect(detectsThinkingBlockError(IDLE_BACKGROUND_SHELLS)).toBe(false)
  })

  it('is false when only the chrome is present without the thinking phrase', () => {
    // A different turn-level API error (rate limit, overloaded) renders
    // the same `⎿  API Error:` chrome but is NOT the thinking-block
    // class. Those recover on their own / via the rate-limit watchdog,
    // so they must not be flagged as the wedged state.
    const rateLimit = [
      '  ⎿  API Error: 429 rate_limit_error: too many requests',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectsThinkingBlockError(rateLimit)).toBe(false)
  })

  it('is false when the phrase appears without the chrome glyph', () => {
    expect(detectsThinkingBlockError(ERROR_FULL_PHRASE_PROSE)).toBe(false)
  })

  it('is false when there is no idle footer (no live region to scope)', () => {
    // Without an idle footer the pane is busy or not a Claude surface;
    // there is no settled live tail to inspect, so we never flag error.
    const noFooter = [
      '  ⎿  API Error: 400 messages.55.content.19: `thinking` blocks cannot be modified.',
      '✻ Combobulating… (12s · ↓ 480 tokens · esc to interrupt)',
    ].join('\n')
    expect(detectsThinkingBlockError(noFooter)).toBe(false)
  })

  it('is false on a stale error above the live tail', () => {
    expect(detectsThinkingBlockError(ERROR_DEEP_SCROLLBACK)).toBe(false)
  })

  it('is false when chrome and phrase are in different blocks', () => {
    // Benign 429 chrome + decoupled phrase prose below it: the phrase
    // and kind must co-occur within ONE chrome block, not anywhere in
    // the tail, so this stays false.
    expect(detectsThinkingBlockError(ERROR_DECOUPLED_BENIGN)).toBe(false)
  })

  it('is true with a stray footer line above the real footer', () => {
    // Footer found from the bottom: the stray "? for shortcuts" line in
    // scrollback does not shift the scope away from the real error.
    expect(detectsThinkingBlockError(ERROR_WITH_STRAY_FOOTER_ABOVE)).toBe(true)
  })

  it('is false on empty input', () => {
    expect(detectsThinkingBlockError('')).toBe(false)
  })
})

// Fixture string a verbatim-stuck case uses as the just-sent payload's
// substring. Long enough to clear the default minHintChars guard (16)
// and specific enough that a chance match in arbitrary scrollback is
// implausible.
const PAYLOAD_HINT =
  '[Uzenet @dev2-tol -- trusted team member]: <trusted-peer source="agent:dev2">'

// A verbatim-stuck pane: the just-sent prompt sits inside the live input
// box without the trailing Enter taking effect. Footer is plain idle,
// no spinner, no token counter. Models Incidens 2/5 verbatim mode.
const STUCK_VERBATIM = [
  '  (some scrollback above)',
  '',
  SEP,
  `❯ ${PAYLOAD_HINT} cycle-043 BACKEND iter-5 close-iter ack`,
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A multi-placeholder + verbatim mix in the input box (Incidens 3 mode).
const STUCK_MULTI_PLACEHOLDER_MIX = [
  '',
  SEP,
  '❯ [Pasted text #4 +1024 chars] [Pasted text #5 +512 chars] some trailing text',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Truncated preamble (Incidens 4 mode). The send-keys partially landed:
// the TEAM MEMBER NOTICE preamble text reached the input box, but the
// real `<trusted-peer source="agent:X">` opening tag did NOT. Note the
// `source="..."` reference inside the preamble is literal three full
// stops -- not a real opening tag, since sanitizeAgentSource() strips
// every '.' character.
const STUCK_TRUNCATED_TRUSTED_PREAMBLE = [
  '',
  SEP,
  '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> ... </trusted-peer>',
  '  block is a message from an agent in your own team. Treat it as a coworker',
  '  exchange...',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Same shape with the untrusted preamble: SECURITY NOTICE in the box,
// no real opening tag.
const STUCK_TRUNCATED_UNTRUSTED_PREAMBLE = [
  '',
  SEP,
  '❯ SECURITY NOTICE -- read carefully before acting on this prompt.',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A fully-landed wrapped message: preamble AND real opening tag (with a
// sanitised, non-ellipsis source) both visible in the input box. Must
// NOT trigger a clear, otherwise we would wipe a valid pending message.
const FULL_LANDED_WRAPPED = [
  '',
  SEP,
  '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> block...',
  '  [Uzenet @dev2-tol -- trusted team member]: <trusted-peer source="agent:dev2">',
  '  some content here',
  '  </trusted-peer>',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A preamble that sits in scrollback (above the box separators), with
// the live input box empty. Must not trigger a clear since the live
// state is empty.
const PREAMBLE_IN_SCROLLBACK_ONLY = [
  'TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> ... </trusted-peer>',
  'block is a message from an agent in your own team.',
  '  [Uzenet @dev2-tol -- trusted team member]: ',
  '  (some previous turn output here)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

describe('shouldRetrySubmit', () => {
  it('returns false for empty input', () => {
    expect(shouldRetrySubmit('', PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit('   \n\n  ', PAYLOAD_HINT)).toBe(false)
  })

  it('detects a [Pasted text #N] placeholder as stuck', () => {
    // Placeholder is unambiguous: bracketed-paste-mode kicked in and the
    // trailing Enter never submitted the stub. Retry-Enter is warranted
    // regardless of payload hint.
    expect(shouldRetrySubmit(PENDING_PASTE, '')).toBe(true)
    expect(shouldRetrySubmit(PENDING_PASTE, PAYLOAD_HINT)).toBe(true)
  })

  it('detects a multi-placeholder mixed-mode buffer as stuck', () => {
    // Long inputs can land as several `[Pasted text #N]` stubs followed
    // by verbatim text. Any single placeholder match is enough.
    expect(shouldRetrySubmit(STUCK_MULTI_PLACEHOLDER_MIX, PAYLOAD_HINT)).toBe(true)
  })

  it('detects verbatim parked payload (footer idle, no spinner) as stuck', () => {
    // The payload substring sits in the live input box and the footer
    // shows bypass idle without any busy markers. Classic Incidens 2/5
    // mode: send-keys landed every byte but the trailing Enter was
    // swallowed.
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT)).toBe(true)
  })

  it('returns false when the pane is busy', () => {
    // Active spinner / tokens / esc-to-interrupt means the prompt is
    // being processed -- retrying Enter would inject an empty line into
    // the next turn's prompt.
    expect(shouldRetrySubmit(BUSY_FULL_FOOTER, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(BUSY_FOOTER_FRAME_GAP, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(BUSY_TOKENS_ONLY, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false on a clean idle pane with no parked input', () => {
    expect(shouldRetrySubmit(IDLE_BYPASS, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(IDLE_STRICT, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(IDLE_BACKGROUND_SHELLS, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false on a non-Claude-Code pane (no idle footer)', () => {
    expect(shouldRetrySubmit(NON_CLAUDE, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false when the operator-typed input does not contain the hint', () => {
    // The pane is typing-state but the parked text is something the
    // operator was typing manually, NOT the just-sent payload. We must
    // not retry Enter -- doing so would submit the operator's draft.
    expect(shouldRetrySubmit(TYPING_PARKED, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false when payloadHint is shorter than minHintChars', () => {
    // Short hints would false-positive on common UI substrings (e.g.
    // matching "OK" or a single word in the box). The caller must pass
    // a hint of at least the configured minimum length to opt into the
    // verbatim-detection path.
    const shortHint = 'short'
    expect(shouldRetrySubmit(STUCK_VERBATIM, shortHint)).toBe(false)
  })

  it('honours a custom minHintChars option', () => {
    // Caller can lower the threshold for deliberate use (e.g. a known
    // short-but-unique sentinel) by passing minHintChars explicitly.
    const hint = 'ack#7421'
    const stuck = [
      '',
      SEP,
      `❯ ${hint} pending submit`,
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldRetrySubmit(stuck, hint, { minHintChars: 8 })).toBe(true)
    // Default threshold rejects the same hint as too short.
    expect(shouldRetrySubmit(stuck, hint)).toBe(false)
  })

  it('does not match the verbatim hint when it only appears in scrollback', () => {
    // The payload substring is in the scrollback above the box (a
    // previous turn's echo), but the live input box is empty. No
    // retry -- the prompt already completed.
    const scrollbackOnly = [
      `  ${PAYLOAD_HINT} -- echoed from a previous turn`,
      '  (more scrollback)',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldRetrySubmit(scrollbackOnly, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false when no idle footer is present (pane state unknown)', () => {
    const noFooter = [
      `❯ ${PAYLOAD_HINT} text without a recognised footer`,
    ].join('\n')
    expect(shouldRetrySubmit(noFooter, PAYLOAD_HINT)).toBe(false)
  })
})

describe('shouldClearTruncatedPreamble', () => {
  it('returns false on empty input', () => {
    expect(shouldClearTruncatedPreamble('')).toBe(false)
  })

  it('detects truncated trusted-peer preamble in the live input box', () => {
    // TEAM MEMBER NOTICE preamble visible, no real opening tag. Caller
    // must Ctrl-U clear before the next send or trust semantics leak.
    expect(shouldClearTruncatedPreamble(STUCK_TRUNCATED_TRUSTED_PREAMBLE)).toBe(true)
  })

  it('detects truncated untrusted preamble in the live input box', () => {
    expect(shouldClearTruncatedPreamble(STUCK_TRUNCATED_UNTRUSTED_PREAMBLE)).toBe(true)
  })

  it('does NOT classify a fully-landed wrapped message as truncated', () => {
    // Preamble AND a real opening tag (sanitised source) both visible:
    // the wrapped content landed end-to-end, no clear needed.
    expect(shouldClearTruncatedPreamble(FULL_LANDED_WRAPPED)).toBe(false)
  })

  it('does NOT trigger when the preamble lives only in scrollback', () => {
    // Live input box is empty -- preamble is a post-turn artifact, not
    // a stale send. A clear would be pointless (and would waste a
    // Ctrl-U on an empty buffer, harmless but noisy in logs).
    expect(shouldClearTruncatedPreamble(PREAMBLE_IN_SCROLLBACK_ONLY)).toBe(false)
  })

  it('does NOT trigger on a clean idle pane', () => {
    expect(shouldClearTruncatedPreamble(IDLE_BYPASS)).toBe(false)
    expect(shouldClearTruncatedPreamble(IDLE_STRICT)).toBe(false)
  })

  it('does NOT trigger when there is no idle footer (pane state unknown)', () => {
    const noFooter = [
      '❯ TEAM MEMBER NOTICE preamble text but no footer',
    ].join('\n')
    expect(shouldClearTruncatedPreamble(noFooter)).toBe(false)
  })

  it('does not confuse the preamble-shaped source="..." reference with a real opening tag', () => {
    // The preamble text itself contains <trusted-peer source="..."> as
    // a reference shape. Those literal three full stops cannot appear
    // in a sanitised source value (sanitizeAgentSource() strips every
    // '.'), so the real-opening-tag regex requires alphanumeric/colon/
    // underscore/dash characters and must not match the reference.
    const preambleOnly = [
      '',
      SEP,
      '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> block',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldClearTruncatedPreamble(preambleOnly)).toBe(true)
  })

  it('returns false when only an opening tag is present without the preamble', () => {
    // No preamble text in the input box means there is nothing to leak;
    // a bare opening tag without preamble is a different shape that
    // this helper does not (and should not) act on.
    const tagOnly = [
      '',
      SEP,
      '❯ <trusted-peer source="agent:dev3">content here',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldClearTruncatedPreamble(tagOnly)).toBe(false)
  })

  it('does NOT trigger when the marker phrase appears only in prose', () => {
    // The bare phrase "TEAM MEMBER NOTICE" or "SECURITY NOTICE" can
    // legitimately show up in operator-typed text or in an agent reply
    // that quotes the marker. The real preamble carries a long,
    // distinctive opening fragment (`TEAM MEMBER NOTICE -- the next
    // <trusted-peer source` and `SECURITY NOTICE -- read carefully
    // before acting`) that is implausible to reproduce by accident in
    // typed prose. Each snippet below shares only a leading substring
    // of the marker and must NOT trigger a clear.
    const prose = [
      // Bare marker, no preamble tail at all.
      '❯ Let me search for TEAM MEMBER NOTICE in the logs',
      '❯ The SECURITY NOTICE policy applies here',
      // Same opening tail as the trusted preamble, then unrelated text.
      // Without the `<trusted-peer source` extension this would have
      // matched the older laxer regex.
      '❯ TEAM MEMBER NOTICE -- the next thing is to check the queue',
      // Same opening tail as the untrusted preamble, then unrelated
      // text. Without the `before acting` extension this would have
      // matched the older laxer regex.
      '❯ SECURITY NOTICE -- read carefully before deploying to prod',
    ]
    for (const promptLine of prose) {
      const pane = [
        '',
        SEP,
        promptLine,
        SEP,
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n')
      expect(shouldClearTruncatedPreamble(pane)).toBe(false)
    }
  })
})

describe('shouldRetrySubmit minHintChars clamp', () => {
  it('clamps minHintChars to at least 1 so an empty hint never auto-passes', () => {
    // Boundary case: a caller passing both an empty payloadHint and
    // minHintChars=0 would otherwise satisfy `payloadHint.length < minHint`
    // as 0 < 0 == false, fall through to inputBox.includes(""), and
    // return true on every non-empty input box. Clamping the floor to
    // 1 turns that into a routine reject.
    expect(shouldRetrySubmit(IDLE_BYPASS, '', { minHintChars: 0 })).toBe(false)
    expect(shouldRetrySubmit(STUCK_VERBATIM, '', { minHintChars: 0 })).toBe(false)
    // A real non-empty hint still works under an explicit minHintChars=1.
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT, { minHintChars: 1 })).toBe(true)
  })

  it('falls back to default when minHintChars is non-finite (NaN / Infinity)', () => {
    // A buggy caller passing NaN would otherwise make
    // `payloadHint.length < NaN` always false, silently disabling the
    // length guard and accepting any hint. Infinity would make the
    // same comparison always true, blocking the verbatim path forever.
    // Both cases must fall back to the default minimum (16) so the
    // helper degrades safely.
    expect(shouldRetrySubmit(STUCK_VERBATIM, 'x', { minHintChars: NaN })).toBe(false)
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT, { minHintChars: NaN })).toBe(true)
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT, { minHintChars: Infinity })).toBe(true)
  })

  it('rejects negative minHintChars by clamping to 1', () => {
    // A negative value (e.g. -5) would let any non-empty hint pass the
    // length guard, even a single-character one. Clamping to >= 1
    // forces at least a one-character hint to be present.
    expect(shouldRetrySubmit(STUCK_VERBATIM, '', { minHintChars: -5 })).toBe(false)
    // The verbatim path still works for a real-length hint with a
    // negative argument.
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT, { minHintChars: -5 })).toBe(true)
  })
})

describe('decideSubmitFollowup', () => {
  it('returns "give-up" when the pane capture failed', () => {
    // A null pane means we cannot tell whether the prompt landed; the
    // safest action is to stop retrying rather than fire a blind
    // Enter that might submit a different turn's draft.
    expect(decideSubmitFollowup(null, PAYLOAD_HINT, 0, 2)).toBe('give-up')
  })

  it('returns "done" when the pane is not stuck', () => {
    // shouldRetrySubmit-positive panes are the only ones that should
    // receive a follow-up Enter. A busy pane, a clean idle pane, and
    // a typing pane without the hint all return "done".
    expect(decideSubmitFollowup(BUSY_FULL_FOOTER, PAYLOAD_HINT, 0, 2)).toBe('done')
    expect(decideSubmitFollowup(IDLE_BYPASS, PAYLOAD_HINT, 0, 2)).toBe('done')
    expect(decideSubmitFollowup(TYPING_PARKED, PAYLOAD_HINT, 0, 2)).toBe('done')
  })

  it('returns "retry-enter" while attempts are below the cap', () => {
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 0, 2)).toBe('retry-enter')
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 1, 2)).toBe('retry-enter')
    expect(decideSubmitFollowup(PENDING_PASTE, '', 0, 2)).toBe('retry-enter')
  })

  it('returns "give-up" once attempts reach the cap', () => {
    // attempt === maxAttempts means we have already fired maxAttempts
    // extra Enters and the pane is still stuck. Bail rather than
    // burning more retries on a pane that refuses to flush.
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 2, 2)).toBe('give-up')
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 5, 2)).toBe('give-up')
  })

  it('treats maxAttempts === 0 as "give-up on first stuck observation"', () => {
    // A caller that disabled retry by passing 0 still gets a clean
    // "give-up" branch (with the warn-log behaviour the loop attaches
    // to that action) rather than silently retrying.
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 0, 0)).toBe('give-up')
    // Done-state on a maxAttempts=0 pane still returns done -- there
    // is nothing to retry.
    expect(decideSubmitFollowup(IDLE_BYPASS, PAYLOAD_HINT, 0, 0)).toBe('done')
  })
})

describe('decidePaneErrorAlert', () => {
  const TH = { confirmMs: 120_000, dedupMs: 1_800_000, clearMs: 300_000 }
  const NONE = { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }

  it('does nothing when not in error and no active spell', () => {
    const d = decidePaneErrorAlert(false, NONE, 5000, TH)
    expect(d.alert).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('records first sighting without alerting (confirm window)', () => {
    const d = decidePaneErrorAlert(true, NONE, 10_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next.firstSeenAt).toBe(10_000)
    expect(d.next.lastAlertAt).toBe(null)
    expect(d.next.lastErrorAt).toBe(10_000)
  })

  it('does not alert while still inside the confirm window', () => {
    // First seen at t=0, now t=60s, confirm window 120s -> not yet.
    const d = decidePaneErrorAlert(true, { firstSeenAt: 0, lastAlertAt: null, lastErrorAt: 0 }, 60_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next.firstSeenAt).toBe(0)
  })

  it('alerts once the confirm window elapses (first alert)', () => {
    const d = decidePaneErrorAlert(true, { firstSeenAt: 0, lastAlertAt: null, lastErrorAt: 60_000 }, 120_000, TH)
    expect(d.alert).toBe(true)
    expect(d.next.firstSeenAt).toBe(0)
    expect(d.next.lastAlertAt).toBe(120_000)
  })

  it('suppresses repeat alerts inside the dedup window', () => {
    // Sustained error, last alert 10 min ago, dedup 30 min -> quiet.
    const d = decidePaneErrorAlert(true, { firstSeenAt: 0, lastAlertAt: 120_000, lastErrorAt: 660_000 }, 720_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next.lastAlertAt).toBe(120_000)
  })

  it('re-alerts once the dedup window elapses', () => {
    // Last alert at t=120s, now t=120s+30min -> dedup elapsed.
    const now = 120_000 + 1_800_000
    const d = decidePaneErrorAlert(true, { firstSeenAt: 0, lastAlertAt: 120_000, lastErrorAt: now - 60_000 }, now, TH)
    expect(d.alert).toBe(true)
    expect(d.next.lastAlertAt).toBe(now)
  })

  it('clears the spell after a sustained error-free gap', () => {
    // error stops, last error 6 min ago (> clearMs 5 min) -> clear.
    const d = decidePaneErrorAlert(false, { firstSeenAt: 0, lastAlertAt: 120_000, lastErrorAt: 60_000 }, 420_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('starts a fresh spell after the cleared recovery', () => {
    // error -> sustained recovery (cleared) -> error again times its own
    // confirm window from the new sighting.
    const recovered = decidePaneErrorAlert(false, { firstSeenAt: 0, lastAlertAt: 120_000, lastErrorAt: 60_000 }, 420_000, TH)
    expect(recovered.next).toEqual(NONE)
    const reappeared = decidePaneErrorAlert(true, recovered.next, 500_000, TH)
    expect(reappeared.alert).toBe(false)
    expect(reappeared.next.firstSeenAt).toBe(500_000)
  })

  it('holds the spell across a brief non-error blip (flapping capture)', () => {
    // A genuinely wedged but flapping session: error, then one non-error
    // tick (null capture / mid-flight busy) only 60s after the last
    // error (< clearMs). The spell must NOT reset, otherwise the confirm
    // window never elapses and the wedged session never alerts.
    const held = decidePaneErrorAlert(false, { firstSeenAt: 0, lastAlertAt: null, lastErrorAt: 60_000 }, 120_000, TH)
    expect(held.alert).toBe(false)
    expect(held.next.firstSeenAt).toBe(0) // spell preserved
    // The next error tick is sustained from the original firstSeenAt and
    // alerts (confirm window elapsed), proving the flap did not starve it.
    const back = decidePaneErrorAlert(true, held.next, 180_000, TH)
    expect(back.alert).toBe(true)
  })

  it('never alerts on the first sighting even when confirmMs is 0', () => {
    // The first-sighting guard means an error must be observed on at
    // least two ticks before any alert, independent of confirmMs. A
    // single transient one-tick error never fires an alert.
    const zeroTh = { confirmMs: 0, dedupMs: 1_800_000, clearMs: 300_000 }
    const first = decidePaneErrorAlert(true, NONE, 1000, zeroTh)
    expect(first.alert).toBe(false)
    expect(first.next.firstSeenAt).toBe(1000)
    // Second tick with confirmMs=0 now alerts (sustained from tick 1).
    const second = decidePaneErrorAlert(true, first.next, 1001, zeroTh)
    expect(second.alert).toBe(true)
  })

  it('does not stall on backwards clock skew (future timestamp)', () => {
    // now jumps backwards (NTP correction): a stored firstSeenAt in the
    // future would drive the delta negative and stall. Instead restart
    // the spell from now rather than getting stuck never-alerting.
    const skewed = decidePaneErrorAlert(true, { firstSeenAt: 1_000_000, lastAlertAt: 1_000_000, lastErrorAt: 1_000_000 }, 500_000, TH)
    expect(skewed.alert).toBe(false)
    expect(skewed.next.firstSeenAt).toBe(500_000)
    expect(skewed.next.lastAlertAt).toBe(null)
  })
})

describe('stuckInputSignature', () => {
  it('returns a normalised signature for parked input', () => {
    const sig = stuckInputSignature(TYPING_PARKED)
    expect(sig).not.toBeNull()
    expect(sig).toContain('Valami amit a felhasznalo elkezdett geppelni')
    // Whitespace collapsed so a re-flow / cursor blink does not look new.
    expect(sig).not.toMatch(/\s{2,}/)
  })

  it('is null for an idle empty input box', () => {
    expect(stuckInputSignature(IDLE_BYPASS)).toBeNull()
  })

  it('is null for a busy pane', () => {
    expect(stuckInputSignature(BUSY_FULL_FOOTER)).toBeNull()
  })

  it('is null for a paste placeholder (treated as busy, not parked text)', () => {
    expect(stuckInputSignature(PENDING_PASTE)).toBeNull()
  })

  it('ignores a ❯ caret left in scrollback', () => {
    expect(stuckInputSignature(IDLE_WITH_SCROLLBACK_CARET)).toBeNull()
  })
})

describe('pendingPasteSignature (card 1b0f58ba: stale-paste recovery)', () => {
  it('returns a normalised signature for a parked paste placeholder', () => {
    const sig = pendingPasteSignature(PENDING_PASTE)
    expect(sig).not.toBeNull()
    expect(sig).toContain('[Pasted text #1 +234 chars]')
    // Whitespace collapsed so a re-flow / cursor blink does not look new.
    expect(sig).not.toMatch(/\s{2,}/)
  })

  it('is null for an idle empty input box', () => {
    expect(pendingPasteSignature(IDLE_BYPASS)).toBeNull()
  })

  it('is null for plain parked typing (that is the stuckInput path)', () => {
    expect(pendingPasteSignature(TYPING_PARKED)).toBeNull()
  })

  // Fixture (c): a live spinner alongside the placeholder means the turn is
  // actually processing the paste -- never recover into a running turn.
  it('ADVERSARIAL: is null when a spinner renders with the placeholder', () => {
    expect(pendingPasteSignature(PENDING_PASTE_WITH_SPINNER)).toBeNull()
  })

  it('is null when a usage-limit footer is showing with the placeholder', () => {
    expect(pendingPasteSignature(PENDING_PASTE_WITH_LIMIT, NOW_BEFORE_RESETS)).toBeNull()
  })

  it('ignores a [Pasted text] echo left in scrollback', () => {
    expect(pendingPasteSignature(PENDING_PASTE_IN_SCROLLBACK)).toBeNull()
  })

  // Fixture (b): the burst is still arriving, so the signature differs from
  // the earlier capture -- the watcher restarts its confirm window.
  it('ADVERSARIAL: a growing placeholder yields a different signature', () => {
    const a = pendingPasteSignature(PENDING_PASTE)
    const b = pendingPasteSignature(PENDING_PASTE_GROWN)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
  })
})

// The three card-mandated adversarial scenarios, exercised end-to-end through
// the real signature extractor + the shared decision machinery (the exact pair
// the watcher wires together), across simulated poll sequences.
describe('stale-paste recovery scenarios (card 1b0f58ba)', () => {
  // Paste confirm window is minutes, not the typing path's 10s.
  const TH = { confirmMs: 150_000, dedupMs: 30_000, maxAttempts: 2 }
  const NONE: StuckInputState = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }

  function run(panes: Array<{ pane: string; at: number }>) {
    let state: StuckInputState = NONE
    const recoveries: number[] = []
    for (const { pane, at } of panes) {
      const sig = pendingPasteSignature(pane)
      const d = decideStuckInputRecovery(sig, state, at, TH)
      if (d.recover) recoveries.push(at)
      state = d.next
    }
    return { state, recoveries }
  }

  it('(a) the SAME placeholder unchanged past the confirm window -> recover', () => {
    const { recoveries } = run([
      { pane: PENDING_PASTE, at: 0 },
      { pane: PENDING_PASTE, at: 60_000 },
      { pane: PENDING_PASTE, at: 160_000 }, // 160s >= 150s confirm
    ])
    expect(recoveries).toEqual([160_000])
  })

  it('(b) a placeholder that grows between polls -> never recover', () => {
    const { recoveries } = run([
      { pane: PENDING_PASTE, at: 0 },
      { pane: PENDING_PASTE_GROWN, at: 60_000 }, // signature changed: restart
      { pane: PENDING_PASTE_GROWN, at: 160_000 }, // only 100s on the new sig
    ])
    expect(recoveries).toEqual([])
  })

  it('(c) a spinner appearing after the placeholder -> never recover', () => {
    const { recoveries, state } = run([
      { pane: PENDING_PASTE, at: 0 },
      { pane: PENDING_PASTE, at: 60_000 },
      { pane: PENDING_PASTE_WITH_SPINNER, at: 160_000 }, // now busy: sig null
    ])
    expect(recoveries).toEqual([])
    // The spell is cleared once the pane is genuinely processing.
    expect(state.parkedSig).toBeNull()
  })

  it('does not exceed maxAttempts even if the stall persists', () => {
    const { recoveries } = run([
      { pane: PENDING_PASTE, at: 0 },
      { pane: PENDING_PASTE, at: 160_000 }, // attempt 1
      { pane: PENDING_PASTE, at: 200_000 }, // attempt 2
      { pane: PENDING_PASTE, at: 240_000 }, // capped
      { pane: PENDING_PASTE, at: 300_000 }, // capped
    ])
    expect(recoveries).toEqual([160_000, 200_000])
  })
})

describe('decideStuckInputRecovery', () => {
  const TH = { confirmMs: 10_000, dedupMs: 12_000, maxAttempts: 3 }
  const NONE = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }

  it('does nothing when nothing is parked and no spell is active', () => {
    const d = decideStuckInputRecovery(null, NONE, 5_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('records the first sighting without recovering (confirm window)', () => {
    const d = decideStuckInputRecovery('msg-A', NONE, 10_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual({ parkedSig: 'msg-A', firstSeenAt: 10_000, lastRecoverAt: null, attempts: 0 })
  })

  it('does not recover while still inside the confirm window', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: null, attempts: 0 }
    const d = decideStuckInputRecovery('msg-A', prev, 9_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.firstSeenAt).toBe(0)
  })

  it('recovers once the same text persists past the confirm window', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: null, attempts: 0 }
    const d = decideStuckInputRecovery('msg-A', prev, 10_000, TH)
    expect(d.recover).toBe(true)
    expect(d.next.attempts).toBe(1)
    expect(d.next.lastRecoverAt).toBe(10_000)
    expect(d.next.firstSeenAt).toBe(0)
  })

  it('restarts the confirm window when the parked text changes', () => {
    // A new/different message arriving (or text still being composed)
    // must not inherit the prior spell's elapsed time.
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: null, attempts: 0 }
    const d = decideStuckInputRecovery('msg-B', prev, 9_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual({ parkedSig: 'msg-B', firstSeenAt: 9_000, lastRecoverAt: null, attempts: 0 })
  })

  it('suppresses a repeat recovery inside the dedup window', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: 10_000, attempts: 1 }
    const d = decideStuckInputRecovery('msg-A', prev, 18_000, TH) // 8s < 12s dedup
    expect(d.recover).toBe(false)
    expect(d.next.attempts).toBe(1)
  })

  it('recovers again once the dedup window elapses', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: 10_000, attempts: 1 }
    const d = decideStuckInputRecovery('msg-A', prev, 22_000, TH) // 12s >= dedup
    expect(d.recover).toBe(true)
    expect(d.next.attempts).toBe(2)
    expect(d.next.lastRecoverAt).toBe(22_000)
  })

  it('gives up after maxAttempts without further recoveries', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: 40_000, attempts: 3 }
    const d = decideStuckInputRecovery('msg-A', prev, 60_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.attempts).toBe(3)
  })

  it('clears the spell when the input box empties', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: 10_000, attempts: 1 }
    const d = decideStuckInputRecovery(null, prev, 30_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('does not stall on backwards clock skew (future timestamp)', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 1_000_000, lastRecoverAt: 1_000_000, attempts: 1 }
    const d = decideStuckInputRecovery('msg-A', prev, 500_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.firstSeenAt).toBe(500_000)
    expect(d.next.lastRecoverAt).toBe(null)
    expect(d.next.attempts).toBe(0)
  })
})

// ===========================================================================
// Channel-less agents: footer-tip-only idle surface (card d3339db9)
// ===========================================================================
//
// The 2026-06-12 Bond-meeting incident: inter-agent messages to five idle
// channel-less agents (scout/quill/bigben/applegate/...) were marked
// "session busy" and silently dropped after the 60-min abandon window.
// Root cause: those agents render the footer WITHOUT the leading
// "⏵⏵ bypass permissions on (shift+tab to cycle)" permission-mode segment
// -- only the rotating onboarding-tip slot "gh auth login · ← for agents"
// remains. The legacy IDLE_FOOTER_RX knew only the bypass/strict footers,
// so detectPaneState read 'unknown' and isReadyForPrompt was false forever.
// The fix recognises the input-box STRUCTURE (two box separators framing a
// ❯ prompt) independently of the rotating footer text.

// Top separator carries the agent's title suffix, exactly as Claude Code
// renders it ("─...─ Dr. Stone ──"). BOX_SEP_RX (^─{10,}) still matches the
// leading run.
const SEP_TITLED = '─'.repeat(60) + ' Dr. Stone ──'

// Clean idle channel-less agent: empty input box, footer slot shows only
// the rotating onboarding tip. THIS is the silent-drop repro -- it must be
// 'idle' so the router/scheduler deliver.
const IDLE_CHANNELLESS_TIP_FOOTER = [
  '  a valódi metrika.',
  '',
  '✻ Cogitated for 1m 2s',
  '          ✗ Auto-update failed: no write permission to npm prefix · Run /doctor',
  SEP_TITLED,
  '❯ ',
  SEP,
  '  gh auth login · ← for agents',
].join('\n')

// Same footer, but a draft parked in the input box -> 'typing' (NOT ready;
// a delivered prompt would concatenate onto the draft).
const PARKED_CHANNELLESS_TIP_FOOTER = [
  '  a valódi metrika.',
  '',
  SEP_TITLED,
  '❯ Küldd el a Big Ben és Quill választ is',
  SEP,
  '  gh auth login · ← for agents',
].join('\n')

// Busy channel-less agent: the tip footer is present but the turn is mid
// flight (token counter). BUSY_INDICATORS must win regardless of footer.
const BUSY_CHANNELLESS_TIP_FOOTER = [
  '✻ Cogitating… (12s · ↓ 1.2k tokens · thinking)',
  '',
  SEP_TITLED,
  '❯ ',
  SEP,
  '  gh auth login · ← for agents',
].join('\n')

// The full composite footer real agents show: permission-mode segment +
// the same rotating tips appended. Still idle (regression guard for the
// agents that were delivering fine).
const IDLE_BYPASS_WITH_TIPS = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · gh auth login · ← for agents',
].join('\n')

// A Claude Code permission dialog (devil-advocate's pane during the
// incident): a y/n menu, NO box separators at all. Must stay 'unknown' --
// injecting a prompt here would corrupt the dialog, so it must never be
// classified idle/ready by the new structural recogniser.
const PERMISSION_MENU = [
  ' Contains brace with quote character (expansion obfuscation)',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend · ctrl+e to explain',
].join('\n')

describe('channel-less footer-tip idle surface (d3339db9)', () => {
  it('classifies a clean idle channel-less agent as idle (the silent-drop repro)', () => {
    expect(detectPaneState(IDLE_CHANNELLESS_TIP_FOOTER)).toBe('idle')
    expect(isReadyForPrompt(IDLE_CHANNELLESS_TIP_FOOTER)).toBe(true)
  })

  it('classifies a parked channel-less box as typing, not ready', () => {
    expect(detectPaneState(PARKED_CHANNELLESS_TIP_FOOTER)).toBe('typing')
    expect(isReadyForPrompt(PARKED_CHANNELLESS_TIP_FOOTER)).toBe(false)
  })

  it('still classifies a busy channel-less agent as busy', () => {
    expect(detectPaneState(BUSY_CHANNELLESS_TIP_FOOTER)).toBe('busy')
    expect(isReadyForPrompt(BUSY_CHANNELLESS_TIP_FOOTER)).toBe(false)
  })

  it('still recognises the full composite footer (real delivering agents)', () => {
    expect(detectPaneState(IDLE_BYPASS_WITH_TIPS)).toBe('idle')
    expect(isReadyForPrompt(IDLE_BYPASS_WITH_TIPS)).toBe(true)
  })

  it('does NOT classify a permission dialog (no input box) as idle/ready', () => {
    expect(detectPaneState(PERMISSION_MENU)).toBe('unknown')
    expect(isReadyForPrompt(PERMISSION_MENU)).toBe(false)
  })
})

// ===========================================================================
// NBSP prompt-glyph drift (card f1ea52c0, 2026-06-23)
// ===========================================================================
//
// The live Claude Code input box now renders the prompt as `❯` + U+00A0
// (NO-BREAK SPACE) before parked text, while echoed history lines in
// scrollback keep a regular U+0020 space. Verified on 5 live channel-less
// panes (store/false-busy-fullpanels-0623.txt): every live box prompt is
// `❯ …`, every scrollback echo is `❯ …`.
//
// PARKED_INPUT_RX was `/❯[ \t]+\S/` (space/tab only), so it went BLIND to a
// parked draft typed at the nbsp prompt: such a pane fell through to 'idle',
// the router would treat it ready and inject a prompt that concatenates onto
// (and corrupts) the operator's unsent draft. This is a false-IDLE bug, the
// OPPOSITE of the "false-busy" the card originally hypothesised (which does
// not reproduce on any capture, truncated or full-panel).
//
// Adversarial-fixture-gate: parked-FN (nbsp draft must read 'typing'),
// parked-FP (nbsp EMPTY box must stay 'idle'; a regular-space scrollback echo
// above the box must stay 'idle'), opposing-combination (scrollback echo
// above + live nbsp draft inside -> 'typing' from the live draft only).
const NBSP = ' '

// parked-FN (the bug): a real captured nbsp parked draft (scout/quill/bigben
// shape). Must be 'typing', not ready.
const NBSP_PARKED_DRAFT = [
  '● Élek, fogadom az üzeneteket.',
  '',
  '✻ Worked for 7s',
  SEP,
  '❯' + NBSP + 'várom a Groq kulcsot, futtasd le a tesztet',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · gh auth login · ← for agents',
].join('\n')

// parked-FP guard: live box prompt is `❯` + nbsp with NO draft text after it
// (applegate/radar shape). Must stay 'idle' / ready -- nothing parked.
const NBSP_EMPTY_BOX = [
  '● Jól vagyok, a restart után stabil.',
  '',
  SEP,
  '❯' + NBSP,
  SEP,
  '  gh auth login · ← for agents',
].join('\n')

// parked-FP guard #2: a regular-space `❯ /compact` echo in scrollback above an
// empty nbsp live box (radar shape). The echo must NOT leak in -> 'idle'.
const NBSP_EMPTY_BOX_WITH_SCROLLBACK_ECHO = [
  '❯ /compact',
  '  ⎿  Not enough messages to compact.',
  '',
  '❯ /compact',
  '  ⎿  Not enough messages to compact.',
  SEP,
  '❯' + NBSP,
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · gh auth login · ← for agents',
].join('\n')

// opposing-combination: a regular-space scrollback echo ABOVE the box AND a
// live nbsp draft INSIDE the box. Must be 'typing' from the live draft; the
// scrollback echo must neither cause nor suppress the classification.
const NBSP_OPPOSING_ECHO_PLUS_DRAFT = [
  '❯ /compact',
  '  ⎿  Not enough messages to compact.',
  '',
  '✻ Brewed for 1m 1s',
  SEP,
  '❯' + NBSP + 'mehet Dave-nek ha Thor zöld',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · gh auth login · ← for agents',
].join('\n')

describe('nbsp prompt-glyph drift (f1ea52c0)', () => {
  it('classifies an nbsp parked draft as typing, not ready (the false-IDLE bug)', () => {
    expect(detectPaneState(NBSP_PARKED_DRAFT)).toBe('typing')
    expect(isReadyForPrompt(NBSP_PARKED_DRAFT)).toBe(false)
  })

  it('merges an nbsp parked draft into busy when mergeTypingAsBusy is set', () => {
    expect(detectPaneState(NBSP_PARKED_DRAFT, { mergeTypingAsBusy: true })).toBe('busy')
  })

  it('keeps an empty nbsp box idle/ready (parked-FP guard)', () => {
    expect(detectPaneState(NBSP_EMPTY_BOX)).toBe('idle')
    expect(isReadyForPrompt(NBSP_EMPTY_BOX)).toBe(true)
  })

  it('does NOT let a regular-space scrollback echo make an empty nbsp box typing', () => {
    expect(detectPaneState(NBSP_EMPTY_BOX_WITH_SCROLLBACK_ECHO)).toBe('idle')
    expect(isReadyForPrompt(NBSP_EMPTY_BOX_WITH_SCROLLBACK_ECHO)).toBe(true)
  })

  it('classifies echo-above + live nbsp draft as typing (opposing-combination)', () => {
    expect(detectPaneState(NBSP_OPPOSING_ECHO_PLUS_DRAFT)).toBe('typing')
    expect(isReadyForPrompt(NBSP_OPPOSING_ECHO_PLUS_DRAFT)).toBe(false)
  })

  it('surfaces an nbsp parked draft as a stuck-input signature', () => {
    expect(stuckInputSignature(NBSP_PARKED_DRAFT)).not.toBeNull()
    expect(stuckInputSignature(NBSP_EMPTY_BOX)).toBeNull()
  })
})

// ===========================================================================
// Usage/session-limit menu (PR #130 DA review, HIGH)
// ===========================================================================
//
// The structural input-box recogniser (d3339db9) keys idle on box STRUCTURE,
// not footer text. The DA flagged a real edge: when the shared Claude account
// hits its usage limit the session renders a blocking limit modal. One render
// (an empty input box plus a "... usage limit · resets at 3pm" footer) has a
// structural box but no parked text, so WITHOUT an explicit guard it would
// fall through to 'idle' = READY, and the message-router/scheduler would
// inject a prompt INTO a limited session (it never processes; on reset it may
// auto-submit stale). The guard classifies any usage-limit surface as 'busy'.
//
// Limit-phrase fixtures use the verbatim captures from the 2026-06-07
// Dave+Thor freezes (see token-outage-bridge.ts LIMIT_PATTERNS), which is the
// authoritative matcher used by the separate token-outage auto-ACK bridge.

// Realistic blocking modal: rounded-corner box (no ─{10,} rule, no idle
// footer). Already 'unknown' pre-guard; the guard makes it the more accurate
// 'busy'.
const LIMIT_MENU_MODAL = [
  '  (prior turn output)',
  '',
  '╭────────────────────────────────────────────────────────────╮',
  "│ You've hit your session limit · resets 7:40pm (Europe/Budapest)",
  '│',
  '│ What do you want to do?',
  '│ ❯ 1. Stop and wait for limit to reset',
  '│   2. Upgrade your plan',
  '╰────────────────────────────────────────────────────────────╯',
].join('\n')

// Worst case for the structural detector: the limit option sits inside a flat
// ─ input box (would otherwise read 'typing'). The guard must win -> 'busy'.
const LIMIT_IN_BOX = [
  SEP,
  '❯ 1. Stop and wait for limit to reset',
  SEP,
  "  You've hit your session limit · resets 7:40pm (Europe/Budapest)",
].join('\n')

// THE false-ready gap: empty input box + a limit footer with a reset time.
// Pre-guard this is 'idle' (box present, no parked ❯ text, footer ignored) =
// READY = the router injects into a limited session. Must be 'busy'.
const LIMIT_SOFT_EMPTY_BOX = [
  SEP,
  '❯ ',
  SEP,
  "  You've reached your usage limit · resets at 3pm",
].join('\n')

// Prose false-positive guard: an idle agent whose reply merely MENTIONS one
// limit phrase (e.g. reviewing token-outage-bridge.ts) with NO corroborating
// signal must stay 'idle'. Co-occurrence (phrase AND reset-time/wait-option)
// is required, mirroring the thinking-block-error AND-combine discipline.
const PROSE_MENTIONS_LIMIT = [
  '  I checked token-outage-bridge.ts: it matches the phrase',
  "  \"you've reached your usage limit\" as one of its limit signals.",
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · gh auth login · ← for agents',
].join('\n')

describe('usage/session-limit menu (PR #130 DA HIGH)', () => {
  it('classifies the blocking limit modal as busy, not ready', () => {
    expect(detectPaneState(LIMIT_MENU_MODAL)).toBe('busy')
    expect(isReadyForPrompt(LIMIT_MENU_MODAL)).toBe(false)
  })

  it('classifies a limit option parked in a box as busy (guard beats typing)', () => {
    expect(detectPaneState(LIMIT_IN_BOX)).toBe('busy')
    expect(isReadyForPrompt(LIMIT_IN_BOX)).toBe(false)
  })

  it('classifies the empty-box limit footer as busy, closing the false-ready gap', () => {
    expect(detectPaneState(LIMIT_SOFT_EMPTY_BOX, { nowMs: NOW_BEFORE_RESETS })).toBe('busy')
    expect(isReadyForPrompt(LIMIT_SOFT_EMPTY_BOX, { nowMs: NOW_BEFORE_RESETS })).toBe(false)
  })

  it('does NOT trip on prose that mentions a single limit phrase', () => {
    expect(detectsUsageLimitMenu(PROSE_MENTIONS_LIMIT)).toBe(false)
    expect(detectPaneState(PROSE_MENTIONS_LIMIT)).toBe('idle')
  })

  it('requires a corroborating signal: phrase alone is not a menu', () => {
    expect(detectsUsageLimitMenu("You've hit your session limit")).toBe(false)
  })

  it('detects phrase + reset-time, and phrase + wait-option', () => {
    expect(
      detectsUsageLimitMenu(
        "You've hit your session limit · resets 7:40pm (Europe/Budapest)",
        NOW_BEFORE_RESETS,
      ),
    ).toBe(true)
    expect(
      detectsUsageLimitMenu('usage limit reached\nStop and wait for limit to reset'),
    ).toBe(true)
  })

  // card c7987f52: the self-reinforcing limit-deadlock. A limit that has SINCE
  // reset leaves its banner in the 18-line tail; the WEAK path used to keep
  // reading it as an active limit -> 'busy' -> the router/scheduler never deliver
  // -> the pane produces no fresh output -> the banner stays in the tail forever.
  // A reset clock-time already in the PAST must age the banner out.
  it('ages out a STALE banner whose reset time has already passed (WEAK path)', () => {
    const staleBanner = "You've hit your session limit · resets 6:50pm (Europe/Budapest)"
    // Active while the reset is still ahead...
    expect(detectsUsageLimitMenu(staleBanner, NOW_BEFORE_RESETS)).toBe(true)
    // ...stale (and ignored) once it has passed.
    expect(detectsUsageLimitMenu(staleBanner, NOW_AFTER_RESETS)).toBe(false)
  })

  it('an empty-box pane with a STALE limit footer is NOT busy (deadlock break)', () => {
    // The exact shape that pinned NoA busy: empty composer + a past-reset footer.
    expect(detectPaneState(LIMIT_SOFT_EMPTY_BOX, { nowMs: NOW_AFTER_RESETS })).not.toBe('busy')
    expect(isReadyForPrompt(LIMIT_SOFT_EMPTY_BOX, { nowMs: NOW_AFTER_RESETS })).toBe(true)
  })

  it('the STRONG menu-option path ignores staleness (active modal you sit in)', () => {
    // "Stop and wait for limit to reset" is chrome of a live blocking modal --
    // it must classify busy even with a past reset time and a future-clock.
    expect(detectsUsageLimitMenu(LIMIT_IN_BOX, NOW_AFTER_RESETS)).toBe(true)
    expect(detectsUsageLimitMenu(LIMIT_MENU_MODAL, NOW_AFTER_RESETS)).toBe(true)
  })

  it('default clock (no nowMs arg) applies staleness live: a far-future reset trips', () => {
    // No injected clock -> live Date.now(). Derive the reset time from Budapest
    // "now" + 3h so the assertion is correct regardless of the host TZ (the guard
    // compares in Europe/Budapest). A reset ~3h out is the realistic active case.
    const bpHour =
      Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Budapest',
          hour: '2-digit',
          hour12: false,
        })
          .formatToParts(new Date())
          .find((p) => p.type === 'hour')!.value,
      ) % 24
    const futureH = (bpHour + 3) % 24
    const hh = ((futureH + 11) % 12) + 1
    const ampm = futureH >= 12 ? 'pm' : 'am'
    expect(
      detectsUsageLimitMenu(`You've hit your session limit · resets ${hh}:00${ampm}`),
    ).toBe(true)
  })

  it('ignores a limit menu that scrolled out of the live tail', () => {
    const deepScrollback = [
      LIMIT_MENU_MODAL,
      ...Array(22).fill('  later idle output line'),
    ].join('\n')
    expect(detectsUsageLimitMenu(deepScrollback)).toBe(false)
  })
})

// =============================================================================
// isActivelyWorking (card 1f0d92a7): the ONLY safe surface to QUEUE input into.
// It is a STRICT SUBSET of 'busy' -- a live turn spinner -- excluding the
// usage-limit menu and pending-paste sub-states that detectPaneState also folds
// into 'busy'. The busy-tier auto-compaction gates on this so a queued /compact
// can only land while a turn is genuinely in progress (runs at the next turn
// boundary), never on a blocking dialog.
// =============================================================================

describe('isActivelyWorking (busy-tier compaction gate)', () => {
  it('is TRUE for a live turn spinner (full footer)', () => {
    expect(isActivelyWorking(BUSY_FULL_FOOTER)).toBe(true)
  })

  it('is TRUE when only the token-stream indicator is present (no spinner label)', () => {
    expect(isActivelyWorking(BUSY_TOKENS_ONLY)).toBe(true)
  })

  it('is TRUE for a spinner during a frame-gap (footer not yet showing esc-to-interrupt)', () => {
    expect(isActivelyWorking(BUSY_FOOTER_FRAME_GAP)).toBe(true)
  })

  it('is TRUE for an active tool-use turn (spinner alongside a tool summary)', () => {
    expect(isActivelyWorking(BUSY_TOOL_USE_ACTIVE)).toBe(true)
  })

  it('is FALSE for an idle pane (idle tiers own that surface)', () => {
    expect(isActivelyWorking(IDLE_BYPASS)).toBe(false)
    expect(isActivelyWorking(IDLE_STRICT)).toBe(false)
    expect(isActivelyWorking(IDLE_AFTER_TOOL_USE)).toBe(false)
  })

  it('is FALSE for a pane with parked/typing input (no running turn)', () => {
    expect(isActivelyWorking(TYPING_PARKED)).toBe(false)
  })

  // THE safety guard: a usage-limit menu is 'busy' by detectPaneState but is a
  // blocking modal -- queuing /compact into it would repeat the #130 false-ready
  // bug (Enter behind a menu, stale auto-submit on reset). Must be FALSE.
  it('is FALSE for a usage-limit menu in every render (NOT a running turn)', () => {
    expect(isActivelyWorking(LIMIT_MENU_MODAL)).toBe(false)
    expect(isActivelyWorking(LIMIT_IN_BOX)).toBe(false)
    expect(isActivelyWorking(LIMIT_SOFT_EMPTY_BOX)).toBe(false)
  })

  it('is FALSE for empty / whitespace-only panes', () => {
    expect(isActivelyWorking('')).toBe(false)
    expect(isActivelyWorking('   \n  \n')).toBe(false)
  })

  it('INVARIANT: actively-working is a strict subset of busy and disjoint from ready', () => {
    // Anything actively working is classified busy by detectPaneState, and is
    // never simultaneously ready-for-prompt.
    for (const pane of [BUSY_FULL_FOOTER, BUSY_TOKENS_ONLY, BUSY_TOOL_USE_ACTIVE]) {
      expect(isActivelyWorking(pane)).toBe(true)
      expect(detectPaneState(pane)).toBe('busy')
      expect(isReadyForPrompt(pane)).toBe(false)
    }
    // A limit menu is busy but NOT actively working -- the subset is strict.
    expect(detectPaneState(LIMIT_MENU_MODAL)).toBe('busy')
    expect(isActivelyWorking(LIMIT_MENU_MODAL)).toBe(false)
  })
})

// =============================================================================
// RETRO #130 follow-up (card 732bb084): truncated-viewport + over-block.
//
// Two delivery-reliability gaps that PR #130 left untested, each the SAME
// false-classification bug from opposite directions:
//
//   (b) TRUNCATED VIEWPORT -> false-READY. A short pane scrolls the limit
//       PHRASE off the top of the visible capture, leaving only the menu
//       action line + input box + footer. The phrase-AND-corroboration rule
//       then misses the menu and the router injects a prompt INTO a limited
//       session -- the exact false-busy bug class, opposite direction.
//
//   (a) OVER-BLOCK -> false-BUSY. Usage-adjacent text scrolling by during
//       normal work (a bare reset time, a single quoted limit phrase) must
//       NOT be read as the limit menu, otherwise a healthy idle agent is
//       treated as busy and its inbound messages silently queue/abandon --
//       the same silent-drop symptom from the other side.
// =============================================================================

// (b) Truncated viewport: only the bottom of a tall limit modal is captured.
// The "You've hit your session limit" phrase scrolled above the visible
// region; the menu ACTION line, the input box and the footer remain. The
// standalone menu-option signal must still classify this 'busy'.
const LIMIT_TRUNCATED_PHRASE_OFFSCREEN = [
  '│ ❯ 1. Stop and wait for limit to reset',
  '│   2. Upgrade your plan',
  '╰────────────────────────────────────────────────────────────╯',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ? for shortcuts',
].join('\n')

// (a) Over-block: an idle agent whose reply prose mentions a bare reset time
// with NO limit phrase ("the nightly cron resets at 3am"). The reset time is
// only weak corroboration and must NOT trip the menu on its own.
const PROSE_RESET_TIME_ONLY = [
  '  The backfill job is scheduled nightly and resets at 3am, so the',
  '  counters you saw are expected to clear by morning.',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n')

describe('truncated-viewport limit menu (card 732bb084 (b))', () => {
  it('detects the menu when the limit phrase scrolled off-screen (closes false-READY)', () => {
    expect(detectsUsageLimitMenu(LIMIT_TRUNCATED_PHRASE_OFFSCREEN)).toBe(true)
    expect(detectPaneState(LIMIT_TRUNCATED_PHRASE_OFFSCREEN)).toBe('busy')
    expect(isReadyForPrompt(LIMIT_TRUNCATED_PHRASE_OFFSCREEN)).toBe(false)
  })

  it('treats the menu action line as a standalone signal (no phrase needed)', () => {
    expect(detectsUsageLimitMenu('❯ 1. Stop and wait for limit to reset')).toBe(true)
  })
})

describe('over-block guard: usage-adjacent prose stays idle (card 732bb084 (a))', () => {
  it('does NOT trip on a bare reset time without a limit phrase', () => {
    expect(detectsUsageLimitMenu(PROSE_RESET_TIME_ONLY)).toBe(false)
    expect(detectPaneState(PROSE_RESET_TIME_ONLY)).toBe('idle')
    expect(isReadyForPrompt(PROSE_RESET_TIME_ONLY)).toBe(true)
  })

  it('does NOT trip on a single limit phrase in reply prose', () => {
    expect(detectPaneState(PROSE_MENTIONS_LIMIT)).toBe('idle')
    expect(isReadyForPrompt(PROSE_MENTIONS_LIMIT)).toBe(true)
  })

  it('does NOT trip on a reset time alone even without any input-box surface', () => {
    expect(detectsUsageLimitMenu('the deploy window resets at 9pm tonight')).toBe(false)
  })
})

// =============================================================================
// Stalled-idle detection (card 845750ad, idle-nudge harness)
// =============================================================================
//
// Background: the 2026-06-13 ~46min stall incident. Dave hit "API Error:
// Overloaded" mid-task -- the turn ended with an empty prompt (pane-level
// idle), but the task was NOT complete. The watchdog, seeing 'idle', did not
// nudge. The agent stayed stalled until operator intervention (stored in
// store/meeting-self-recovery-context.md, cards 845750ad + 5899286b).
//
// The core problem: "API Overloaded -> dropped to idle" and "genuinely done
// -> idle" are PANE-CAPTURE IDENTICAL. Neither busy indicators, footer text,
// nor input-box structure can tell them apart. The only distinguishing signal
// is external: does the agent have an open task (kanban card / pending msg)?
//
// detectsStalledIdle() couples the pure pane-state result with an externally
// injected IdleNudgeContext. The tests below are the mandatory 3-fixture
// boundary corpus from the card description, plus negative guards.
//
// ADVERSARIAL 3-FIXTURE RULE (card 23dac481): every pane-state detector
// change must include:
//   - false-positive guard (nudge would fire on a healthy pane)
//   - false-negative guard (nudge would NOT fire on a stalled pane)
//   - opposing-combination guard (swap context, prove it flips)

// Fixture A: "API Overloaded -> empty prompt". The session hit a 529
// overloaded error; the turn ended and the pane dropped to idle. The
// error chrome (⎿ API Error: 529) appears in the scrollback, but the
// turn is done: no spinner, no "esc to interrupt", no thinking-block
// phrase. detectPaneState -> 'idle'. Pane-level identical to Fixture C.
const STALLED_OVERLOADED_EMPTY = [
  '  ⎿  API Error: 529 overloaded_error: Anthropic API Overloaded. Please retry after 1 minute.',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Fixture B: mid-thinking. Active turn in flight: spinner + token counter.
// Reuses BUSY_FOOTER_FRAME_GAP (spinner visible, footer still in frame-gap
// idle state -- the hardest positive busy case). detectPaneState -> 'busy'.
const MID_THINKING_WITH_TASK = BUSY_FOOTER_FRAME_GAP

// Fixture C: genuinely done. Agent completed its task, the pane is idle.
// Pane-level identical to Fixture A -- the only difference is external state.
const GENUINELY_DONE_IDLE = IDLE_BYPASS

describe('detectsStalledIdle (card 845750ad, idle-nudge boundary corpus)', () => {
  // --- The three mandatory boundary fixtures (card description) ---

  it('[A] idle + overloaded-error-in-scrollback + hasOpenTask=true -> nudge=true (stall)', () => {
    // FALSE-NEGATIVE guard: a stalled post-overload agent MUST be detected.
    // The ⎿ API Error: 529 is in scrollback (turn ended), so detectPaneState
    // reads 'idle'. The open task is what confirms this is a stall.
    // CRITICAL: if hasOpenTask were derived from the pane string this would
    // always be false -- the invariant requires external injection.
    expect(detectsStalledIdle(STALLED_OVERLOADED_EMPTY, { hasOpenTask: true })).toBe(true)
  })

  it('[B] mid-thinking spinner + hasOpenTask=true -> nudge=false (busy, not stalled)', () => {
    // FALSE-POSITIVE guard: an actively thinking agent must never be nudged.
    // BUSY_INDICATORS win inside detectPaneState -> 'busy' -> detectsStalledIdle
    // returns false before even inspecting hasOpenTask.
    expect(detectsStalledIdle(MID_THINKING_WITH_TASK, { hasOpenTask: true })).toBe(false)
  })

  it('[C] genuinely-done idle + hasOpenTask=false -> nudge=false (done)', () => {
    // OVER-NUDGE guard: an idle agent with no open tasks must not receive
    // a nudge. Without the hasOpenTask gate, every idle pane on every
    // watchdog tick would be wrongly nudged.
    expect(detectsStalledIdle(GENUINELY_DONE_IDLE, { hasOpenTask: false })).toBe(false)
  })

  // --- Opposing-combination: prove external state is the decisive flip ---

  it('[A-flip] same overloaded pane + hasOpenTask=false -> nudge=false (already done)', () => {
    // The agent happened to finish its task before the overloaded error
    // surfaced (or it was a one-shot query). No obligation remains -> no nudge.
    // Proves the flip: SAME pane, opposite context, opposite result.
    expect(detectsStalledIdle(STALLED_OVERLOADED_EMPTY, { hasOpenTask: false })).toBe(false)
  })

  it('[C-flip] same done-looking pane + hasOpenTask=true -> nudge=true (unknown stall)', () => {
    // Pane looks identical to "genuinely done" but the kanban shows an open card.
    // The watchdog cannot know if this is post-overload or a task abandoned
    // mid-flight -- it nudges and lets the agent self-determine. Proves flip:
    // SAME pane, opposite context, opposite result.
    expect(detectsStalledIdle(GENUINELY_DONE_IDLE, { hasOpenTask: true })).toBe(true)
  })

  // --- Negative guards: non-idle states must never trigger the nudge ---

  it('does not nudge a typing pane (text parked in input box)', () => {
    // 'typing' state: the agent is composing or the operator has parked text.
    // A nudge would concatenate onto the draft.
    expect(detectsStalledIdle(TYPING_PARKED, { hasOpenTask: true })).toBe(false)
  })

  it('does not nudge an unknown surface (non-Claude pane)', () => {
    // A raw shell or build log pane -- no Claude Code input box, no idle surface.
    // Injecting a nudge prompt here would corrupt the running process.
    expect(detectsStalledIdle(NON_CLAUDE, { hasOpenTask: true })).toBe(false)
  })

  it('does not nudge a pane wedged in the thinking-block error', () => {
    // 'error' state has its own recovery path (decidePaneErrorAlert + alert).
    // The idle-nudge watchdog must not double-fire on an already-alerted error;
    // further prompt injection into a wedged session yields another 400.
    expect(detectsStalledIdle(ERROR_THINKING_BLOCK, { hasOpenTask: true })).toBe(false)
  })

  it('does not nudge a usage-limit modal pane', () => {
    // Usage-limit modal -> 'busy'. A nudge prompt would queue stale and
    // may auto-submit after the reset, corrupting the next turn.
    expect(detectsStalledIdle(LIMIT_MENU_MODAL, { hasOpenTask: true })).toBe(false)
  })

  it('does not nudge a channel-less idle agent with no open task', () => {
    // Channel-less agents (tip-footer) classify as 'idle' via the structural
    // box recogniser. With hasOpenTask=false they are genuinely done -> no nudge.
    expect(detectsStalledIdle(IDLE_CHANNELLESS_TIP_FOOTER, { hasOpenTask: false })).toBe(false)
  })

  it('nudges a channel-less idle agent that has an open task', () => {
    // Same channel-less surface but with hasOpenTask=true: the agent is expected
    // to be working but is sitting idle. This covers the 2026-06-13 Dave stall
    // shape: the incident was on the main agent but channel-less sub-agents are
    // equally susceptible to post-overload silent stalls.
    expect(detectsStalledIdle(IDLE_CHANNELLESS_TIP_FOOTER, { hasOpenTask: true })).toBe(true)
  })
})

// Card d978f8bd (RETRO #130 follow-up, Dave #2): fail-safe default-flip.
// 'idle' must be POSITIVELY proven by an editable input-affordance (the
// structural input box: two box-separators framing a ❯ prompt), NOT merely
// inferred from a recognised footer. The root finding: 'idle' was the optimistic
// fall-through, so a render that carried an idle-looking footer but NO live input
// box (a truncated viewport that scrolled the box off, a mid-render frame, a
// non-promptable surface) was read as READY and the scheduler/router injected
// into it. The flip makes a missing box -> 'unknown' (not-ready), trading the
// worse false-READY for a deferrable false-BUSY (never-drop retry #136 + the
// abandon-rate metric 732bb084 are the safety net). All genuine idle surfaces
// already render the box, so they stay 'idle'.
describe('positive input-affordance required for idle (card d978f8bd)', () => {
  // THE FLIP: a fully-recognised idle footer with NO structural input box is no
  // longer 'idle'. Previously this fell through to 'idle' (footer was a
  // sufficient surface signal); now the absent affordance makes it 'unknown'.
  it('footer matches but NO input box -> unknown (was the optimistic idle fall-through)', () => {
    const footerNoBox = [
      '  some prior tool output, then the box scrolled out of the viewport',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    // sanity: the footer string itself IS the recognised idle footer
    expect(/bypass permissions on \(shift\+tab to cycle\)/.test(footerNoBox)).toBe(true)
    expect(detectPaneState(footerNoBox)).toBe('unknown')
  })

  // OVER-BLOCK GUARD (false-negative): a real idle pane WITH a complete input box
  // must stay 'idle'. The flip must not start dropping genuine idle surfaces.
  it('complete input box -> idle (no over-block regression)', () => {
    expect(detectPaneState(IDLE_BYPASS)).toBe('idle')
    expect(detectPaneState(IDLE_STRICT)).toBe('idle')
  })

  // BOX SUFFICIENT (d3339db9 stays fixed): a box with only a rotating-tip footer
  // (no "bypass permissions on" segment, so IDLE_FOOTER_RX misses) is STILL idle,
  // because the box is the positive affordance. The flip must not regress the
  // channel-less tip-footer fix into a silent drop.
  it('input box with an unrecognised tip-only footer -> idle (box is sufficient)', () => {
    expect(detectPaneState(IDLE_CHANNELLESS_TIP_FOOTER)).toBe('idle')
  })

  // OPPOSING-COMBINATION: a live busy indicator present alongside a complete box
  // -> 'busy' wins. Ordering (busy short-circuits before the affordance check) is
  // preserved by the flip.
  it('busy indicator + complete box -> busy (busy short-circuits the affordance check)', () => {
    const busyWithBox = [
      '  Synthesizing… (12s · ↓ 1.2k tokens)',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(busyWithBox)).toBe('busy')
  })

  // No box AND no footer -> still unknown (unchanged baseline negative).
  it('no box and no footer -> unknown (unchanged)', () => {
    expect(detectPaneState('  just some raw shell output\n  $ ls -la')).toBe('unknown')
  })
})

describe('isQuiescentlyIdle (L2 delivery backstop, card d4aa1d14)', () => {
  // The orthogonal "is anything happening?" idle proof. detectPaneState cannot
  // self-heal a PERSISTENT false-not-ready (same captured pane -> same wrong
  // answer, recomputed fresh each poll -- there is no sticky state to clear). A
  // live turn ALWAYS mutates the at-or-above-box region (spinner frames cycle,
  // the token counter ticks, tokens stream), so a byte-stable region across
  // samples + an empty/ghost composer + no busy signal proves a finished turn,
  // regardless of what the content heuristics say. NEVER true for a real draft
  // (that would concatenate a prompt -- the destructive #284 false-IDLE).

  const footer = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const emptyBox = ['done: last output', SEP, '❯ ', SEP, footer].join('\n')
  const ghostBox = ['done: last output', SEP, '❯ merge PR #283', SEP, footer].join('\n')
  const draftBox = ['done: last output', SEP, '❯ git status', SEP, footer].join('\n')
  const s = (pane: string, cursor?: { x: number; y: number }): QuiescenceSample => ({ pane, cursor })

  it('stable empty composer across samples -> quiescently idle', () => {
    expect(isQuiescentlyIdle([s(emptyBox), s(emptyBox), s(emptyBox)])).toBe(true)
  })

  it('stable ghost-only composer (cursor at suggestion start) -> idle', () => {
    const c = { x: 2, y: 2 }
    expect(isQuiescentlyIdle([s(ghostBox, c), s(ghostBox, c), s(ghostBox, c)])).toBe(true)
  })

  it('CRITICAL: a real parked draft (cursor after text) is NEVER quiescently idle', () => {
    const c = { x: 12, y: 2 }
    expect(isQuiescentlyIdle([s(draftBox, c), s(draftBox, c), s(draftBox, c)])).toBe(false)
  })

  it('a ghost line WITHOUT a cursor is not provable idle (safe -> false)', () => {
    expect(isQuiescentlyIdle([s(ghostBox), s(ghostBox)])).toBe(false)
  })

  it('above-box mutation (streaming output) -> not quiescent', () => {
    const a = ['thinking a', SEP, '❯ ', SEP, footer].join('\n')
    const b = ['thinking ab', SEP, '❯ ', SEP, footer].join('\n')
    expect(isQuiescentlyIdle([s(a), s(b), s(b)])).toBe(false)
  })

  it('only the rotating-tip footer changes (above-box stable) -> still idle', () => {
    const tip1 = ['done: last output', SEP, '❯ ', SEP, '  ← for agents'].join('\n')
    const tip2 = ['done: last output', SEP, '❯ ', SEP, '  gh auth login · ← for agents'].join('\n')
    expect(isQuiescentlyIdle([s(tip1), s(tip2), s(tip1)])).toBe(true)
  })

  it('a live spinner anywhere -> not idle (busy signal wins)', () => {
    const spin = ['✢ Combobulating… (3s · ↓ 1.2k tokens)', SEP, '❯ ', SEP, footer].join('\n')
    expect(isQuiescentlyIdle([s(spin), s(spin), s(spin)])).toBe(false)
  })

  it('a usage-limit modal is static but NEVER idle (must not inject into it)', () => {
    const modal = ['Stop and wait for limit to reset', SEP, '❯ ', SEP, footer].join('\n')
    expect(isQuiescentlyIdle([s(modal), s(modal), s(modal)])).toBe(false)
  })

  it('a pending-paste placeholder -> not idle', () => {
    const paste = ['done', SEP, '❯ [Pasted text #1 +200 chars]', SEP, footer].join('\n')
    expect(isQuiescentlyIdle([s(paste), s(paste), s(paste)])).toBe(false)
  })

  it('no structural box in the latest sample -> not idle (c88bc682 boundary)', () => {
    const noBox = '  just raw shell output\n  $ ls -la'
    expect(isQuiescentlyIdle([s(emptyBox), s(noBox)])).toBe(false)
  })

  it('a single sample cannot prove stability -> false', () => {
    expect(isQuiescentlyIdle([s(emptyBox)])).toBe(false)
  })

  it('empty sample list -> false', () => {
    expect(isQuiescentlyIdle([])).toBe(false)
  })
})
