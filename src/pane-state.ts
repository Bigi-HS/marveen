// Pure-logic detector for a tmux pane running Claude Code.
//
// Motivation: the scheduler used a single regex (`/esc to interrupt/`) to
// decide whether a target session could accept a new prompt. Between a
// user turn's submission and the spinner's first render there is a frame-
// scale window where the footer shows only `⏵⏵ bypass permissions on
// (shift+tab to cycle)` WITHOUT the `· esc to interrupt` suffix. A
// scheduler tick landing in that window mis-detected "ready", called
// sendPromptToSession, and the prompt sat in the input buffer until the
// post-send retry gave up. The new detector:
//
//   - Recognises a wider range of positive busy indicators (spinner
//     glyph labels + token-count pattern + tool-use mid-turn lines)
//     so the frame-level footer gap no longer yields a false positive.
//   - Returns a discrete state so the caller can distinguish idle /
//     busy / typing / unknown and react per state.
//
// The module has ZERO imports so it is trivially unit-testable against
// captured pane fixtures. The I/O (capture-pane + double-sample) lives
// in src/web.ts alongside the rest of the scheduler.

export type PaneState = 'idle' | 'busy' | 'typing' | 'unknown' | 'error'

// The footer + input-box patterns below were last hand-validated against this
// CLI version. This is a DOCUMENTATION reference only -- no runtime code reads
// it (the live drift enforcement is the pane-detector gate, card 56ad0fa3:
// fleet-supervisor.sh flags a CLI drift and the pane-dependent watchdogs stand
// down via pane-detector-gate.ts until a c12 smoke clears it with
// `tsx scripts/pane-detector-smoke-clear.ts`). Bump this when the regexes are
// re-validated against a new CLI release, for human reference.
export const PANE_DETECTOR_BASELINE_CLI_VERSION = '2.1.160'

// Claude Code shows the footer in one of two modes: the default "bypass"
// permissions mode (permissive) and the "strict" mode. Both are "idle"
// surfaces. If neither is visible the pane is not a recognised Claude
// Code surface and we report 'unknown' rather than guess.
//
// The bypass-mode footer has known trailing variants after the
// "bypass permissions on" prefix: the original "(shift+tab to cycle)"
// hint, and the background-shells indicator which Claude Code
// substitutes when one or more BashTool background shells are running
// in the session. The background-shells indicator itself comes in two
// shapes depending on whether the tasks panel is visible:
//   - tasks visible:  "· N shells · ctrl+t to hide tasks · ↓ to manage"
//   - tasks hidden:   "· N shells · ↓ to manage"
// All variants must classify as idle, otherwise sessions that spawn
// background shells (gh poll, file watchers, long-running build) get
// stuck pending forever.
//
// The shells-variant requires either the "· ctrl+t" marker or the
// "· ↓ to manage" tail after the shell count, rather than just the
// bare "· N shell(s)" prefix. Two reasons:
//   (a) one of these tails is always what Claude Code actually renders,
//       so insisting on either rejects malformed or mid-render frames;
//   (b) it disambiguates the footer from scrollback content that
//       happens to contain "bypass permissions on · 1 shell" verbatim
//       (an echoed log line, a quoted message, etc.) which would
//       otherwise be misread as idle.
const IDLE_FOOTER_RX = /bypass permissions on(?: \(shift\+tab to cycle\)| · \d+ shells? · (?:ctrl\+t|↓ to manage))|\? for shortcuts/

// Positive busy signals. ANY match anywhere in the pane means the turn
// is mid-flight, even if the footer looks idle for a frame.
//
// Deliberately narrow: only signals that disappear THE MOMENT a turn
// ends. Two failure modes we explicitly avoid:
//
//   (A) Scrollback persistence. Tool-use summary lines (`Searched for /
//       Listed / Read`) stay rendered above the input box after the
//       turn ends, and Claude Code never overwrites them. A regex
//       matching those would starve the scheduler forever.
//
//   (B) Prose false positive. The standalone word "Thinking…" or
//       "Crafting…" could legitimately appear in Claude's reply text
//       (Markdown headings, list items, quoted content). Matching the
//       label alone would read that prose as mid-turn. To avoid this
//       we require the label to be followed by the parenthesised
//       runtime marker `(Ns · ↓` -- an UI chrome signature that
//       cannot appear in reply text.
//
// The load-bearing signal is the tokens-down-arrow pattern `(Ns · ↓N`,
// which every extended-thinking turn renders regardless of spinner
// label. `esc to interrupt` is the footer-scoped fallback. A future
// Claude Code release that renames the spinner labels will miss the
// label regex but still be caught by the tokens pattern.

// Known Claude Code turn-spinner labels (last validated: CLI 2.x, 2026-06-21).
// Non-exhaustive by design: the bare token-counter pattern is the authoritative
// fallback. Update this list when the CLI adds or renames spinners; the regex
// below is rebuilt from it automatically so there's only one place to edit.
export const CLAUDE_SPINNER_LABELS: readonly string[] = [
  'Combobulating', 'Beaming', 'Thinking', 'Pondering', 'Reticulating',
  'Configuring', 'Noodling', 'Ruminating', 'Percolating', 'Cogitating',
  'Deliberating', 'Contemplating', 'Musing', 'Brewing', 'Synthesizing',
  'Distilling', 'Refining', 'Simmering', 'Crafting', 'Formulating',
  'Consulting', 'Unfurling', 'Unspooling', 'Unraveling',
]

const BUSY_INDICATORS: RegExp[] = [
  /\besc to interrupt\b/,
  // Tokens-down-arrow counter: "(52s · ↓ 2.6k tokens ..." Turn-scoped,
  // overwritten with whitespace the moment the turn completes.
  /\(\s*\d+s\s*·\s*↓\s*\d/,
  // Known spinner labels paired with the turn-scoped `(Ns · ↓` tail on
  // the same line. The tail requirement kills the "Thinking…" prose
  // false positive. Non-exhaustive by design; the bare tokens pattern
  // above is the authoritative fallback.
  new RegExp(`\\b(?:${CLAUDE_SPINNER_LABELS.join('|')})…\\s*\\(\\s*\\d+s\\s*·\\s*↓`),
]

// Pasted-text placeholder. Claude Code lifts bursts of input keys into
// `[Pasted text #N +X chars]` stubs, which sit in the input buffer and
// never auto-submit on Enter. Treat as busy so the scheduler doesn't pile
// a second prompt on top.
const PENDING_PASTE_RX = /\[Pasted text #\d+/

// Usage/session-limit modal (PR #130 DA review, HIGH). When the shared Claude
// account hits its limit the session renders a blocking "What do you want to
// do? / Stop and wait for limit to reset / Upgrade your plan" menu. Some
// renders of that surface (notably an empty input box plus a "... usage limit
// · resets at 3pm" footer) present a structural input box with no parked text,
// so the d3339db9 structural recogniser would otherwise read them as 'idle' =
// READY and the message-router/scheduler would inject a prompt INTO a limited
// session (it never processes; on reset it may auto-submit stale). The guard
// below classifies any usage-limit surface as 'busy' regardless of box/footer.
//
// Two-tier signal model (PR #130 + card 732bb084):
//
//   STRONG -- the menu action line "Stop and wait for limit to reset". This is
//     unambiguous Claude Code UI chrome, not natural reply prose, so it is
//     sufficient ALONE to recognise the menu (matching token-outage-bridge.ts's
//     authoritative LIMIT_PATTERNS). Required to close the truncated-viewport
//     gap: a short pane scrolls the limit PHRASE off the top of the visible
//     capture, leaving only this option line + input box + footer; a phrase-AND-
//     corroboration rule would miss it -> 'idle' = READY = a prompt injected
//     INTO a limited session (the false-busy bug class, opposite direction).
//
//   WEAK -- a bare reset time ("resets at 3pm"). It can legitimately appear in
//     reply prose ("the nightly cron resets at 3am"), so it counts only TOGETHER
//     with a limit phrase. On its own it must NOT trip the menu, otherwise a
//     healthy idle agent is read as busy and its inbound queues/abandons (the
//     over-block direction). A lone limit phrase is likewise insufficient: an
//     agent reviewing token-outage code can print one in its reply.
//
// All signals are scoped to the bottom lines (the menu renders there), never
// deep scrollback. The authoritative, fuller pattern list lives in
// token-outage-bridge.ts (LIMIT_PATTERNS); both derive from the verbatim
// 2026-06-07 Dave+Thor freeze captures and are kept INLINE here to preserve
// this module's zero-import, unit-testable design.
const LIMIT_PHRASE_RX = /you've (?:hit|reached) your (?:usage|session) limit|(?:usage|session) limit reached|claude usage limit|limit will reset/i
const LIMIT_MENU_OPTION_RX = /stop and wait for limit to reset/i
const LIMIT_RESET_TIME_RX = /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)/i
const LIMIT_MENU_TAIL_LINES = 18

// Input-box separator lines are made of U+2500 BOX DRAWINGS LIGHT
// HORIZONTAL. At least 10 in a run to ignore stray `-` glyphs.
const BOX_SEP_RX = /^─{10,}/

// Prompt line inside the input box. `❯` followed by at least one
// horizontal whitespace and then a non-whitespace character means the
// user (or a send-keys that didn't submit) parked text there. The live
// box now renders the prompt as `❯` + U+00A0 (NO-BREAK SPACE), not a
// regular space (CLI-drift verified 2026-06-23, card f1ea52c0), so the
// class must cover ANY whitespace except newline -- `[^\S\n]` matches
// space, tab, U+00A0 and any future unicode space glyph while staying
// single-line (never crossing into the next line). The trailing `\S`
// keeps an empty box (`❯` + space, nothing typed) classified idle.
const PARKED_INPUT_RX = /❯[^\S\n]+\S/

/**
 * Locate the live Claude Code input box from STRUCTURE alone: the two
 * bottom-most box-separator lines (─{10,}) that frame a ❯ prompt line.
 *
 * Footer-text independent on purpose. Claude Code's footer slot rotates
 * onboarding tips ("gh auth login · ← for agents", "← for agents", …),
 * and for some sessions the leading "⏵⏵ bypass permissions on
 * (shift+tab to cycle)" permission-mode segment is absent, leaving only a
 * tip. Keying idle-surface recognition on the footer text (IDLE_FOOTER_RX)
 * then misreads those panes as 'unknown', and the message-router/scheduler
 * treat the agent as permanently busy, so the message is silently dropped
 * after the abandon window (card d3339db9, 2026-06-12 Bond-meeting
 * incident). The box structure does not rotate, so it is the reliable
 * surface signal.
 *
 * Returns the {topSep, bottomSep} line indices, or null when the pane has
 * no live input box (a shell, a permission dialog, raw output): callers
 * treat null as "not a promptable Claude Code surface".
 */
function findInputBoxBounds(lines: string[]): { topSep: number; bottomSep: number } | null {
  // Bottom-most separator: the box's lower rule. The footer/tip line sits
  // BELOW it and is plain text (never ─{10,}), so scanning from the end
  // lands on the box bottom, not the footer.
  let bottomSep = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { bottomSep = i; break }
  }
  if (bottomSep <= 0) return null
  let topSep = -1
  for (let i = bottomSep - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { topSep = i; break }
  }
  if (topSep < 0) return null
  // The framed region must contain a ❯ prompt, otherwise two unrelated
  // rule lines (a markdown table, ASCII art) would be misread as a box.
  for (let i = topSep + 1; i < bottomSep; i++) {
    if (lines[i].includes('❯')) return { topSep, bottomSep }
  }
  return null
}

/**
 * Cursor-aware ghost/autosuggestion discrimination (card c8d13cc0).
 *
 * The Claude Code TUI draws a dim autosuggestion into an EMPTY composer to the
 * RIGHT of the cursor; a real draft sits to the LEFT. `tmux capture-pane -p`
 * strips the dim attribute, so the suggestion and a real draft are
 * byte-identical in the captured string -- the cursor column is the only
 * reliable, version-independent discriminator (the standard shell-autosuggest
 * shape). Returns true when the parked text on the cursor's prompt line is
 * PURELY a suggestion: the cursor sits at (or before) the first visible glyph,
 * so nothing has actually been typed and the composer is empty (promptable).
 *
 * Conservative by design: any ambiguity (cursor on another row, cursor past the
 * prompt content, no caret) returns false so the caller keeps the safe 'typing'
 * classification. A false-IDLE is the destructive direction -- a prompt would
 * concatenate into a real draft -- so the guard only fires on the unambiguous
 * empty-composer-with-suggestion shape. Residual edge: a real draft whose
 * cursor was manually moved to the line start (Home) is indistinguishable here
 * and would read as ghost; autonomous panes never do this, and the structural
 * redeliver layer (follow-up) catches any such miss.
 */
function isGhostSuggestionOnly(
  lines: string[],
  box: { topSep: number; bottomSep: number },
  cursor: { x: number; y: number },
): boolean {
  // The cursor must sit on a prompt line strictly inside the live box.
  if (cursor.y <= box.topSep || cursor.y >= box.bottomSep) return false
  const line = lines[cursor.y]
  if (line === undefined) return false
  const caret = line.indexOf('❯')
  if (caret < 0) return false
  // Content starts at the first non-whitespace glyph after the caret marker
  // (the prompt renders `❯` + a space or U+00A0 before any text/suggestion).
  let start = caret + 1
  while (start < line.length && /[^\S\n]/.test(line[start]!)) start++
  if (start >= line.length) return false // no visible text on this line
  // Cursor at/before the first glyph -> nothing typed -> the visible text is a
  // suggestion drawn to the right of the cursor (empty composer).
  return cursor.x <= start
}

// Persistent Anthropic thinking-block API error. When an assistant turn
// ends with a 400 about thinking/redacted_thinking blocks that "cannot
// be modified", the session is wedged: every subsequent prompt re-sends
// the same context and yields the identical 400. The pane shows the idle
// footer (turn "finished") plus a past-tense thinking stamp but NO live
// busy indicator, so detectPaneState would otherwise classify it 'idle'
// and the scheduler/router would keep injecting -- each injection
// another doomed 400. Surfacing this as a distinct 'error' state makes
// isReadyForPrompt() return false so injection stops, and lets the
// channel monitor alert that a manual reset is needed.
//
// Three guards, ALL required, to avoid flagging a healthy session that
// merely quotes the error text (a bug-report message, a log analysis):
//
//   (a) Position scope: only the "live tail" (the lines just above the
//       idle footer) is inspected, never deep scrollback. A long-ago
//       turn's error echo above the live region is ignored. The footer
//       is found from the BOTTOM (the live footer is always the last
//       line of the pane) so a footer-looking string quoted higher up
//       in scrollback does not shift the scope.
//   (b) Chrome glyph: the error must render as a tool-output line
//       `⎿  API Error: <code>` -- the U+23BF result glyph Claude Code
//       prints before a turn-level error. Prose that quotes "API Error
//       400" in a message body has no leading `⎿  API Error: <num>`.
//   (c) Specific phrase: the thinking-block signature `cannot be
//       modified` together with `thinking` or `redacted_thinking`. A
//       generic API error (rate limit, overloaded) is NOT this class.
//
// (b) and (c) are required WITHIN ONE CHROME BLOCK (the chrome line plus
// its wrapped continuation), not anywhere in the joined tail. Otherwise
// a benign `⎿ API Error: 429` on one line plus an unrelated "thinking
// ... cannot be modified" prose on another line would AND-combine into
// a false positive on a healthy session.
const ERROR_CHROME_RX = /⎿\s*API Error:\s*\d+/
const ERROR_THINKING_PHRASE_RX = /cannot be modified/
const ERROR_THINKING_KIND_RX = /\b(?:redacted_thinking|thinking)\b/

// How many lines above the idle footer count as the "live tail". The
// error output (the `⎿` line + its wrapped continuation), the thinking
// stamp, and the input box together span well under 20 lines; 20 gives
// margin for terminal re-flow without reaching deep scrollback.
const ERROR_LIVE_TAIL_LINES = 20

// How many lines a single API-error render spans: the `⎿` chrome line
// plus its wrapped continuation. The thinking-block message is long and
// the terminal wraps it; at ~80 cols "cannot be modified" lands on the
// 2nd line, at ~60 cols on the 3rd-4th. 4 covers narrow panes while
// staying short enough that an adjacent unrelated chrome block does not
// bleed in (the decoupled-benign test pins this boundary).
const ERROR_BLOCK_LINES = 4

/**
 * True when the pane is wedged in the persistent thinking-block API
 * error described above. Scoped to the live tail above the idle footer
 * so a quoted error string in scrollback or a message body does not
 * trigger a false positive. Returns false when there is no idle footer
 * (the pane is busy or not a recognised Claude Code surface).
 */
export function detectsThinkingBlockError(pane: string): boolean {
  if (!pane) return false
  const lines = pane.split('\n')
  // Find the footer from the bottom: the live footer is the last line of
  // the pane, so a footer-looking line quoted in scrollback must not win.
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (IDLE_FOOTER_RX.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx < 0) return false
  const start = Math.max(0, footerIdx - ERROR_LIVE_TAIL_LINES)
  const tail = lines.slice(start, footerIdx)
  // The chrome glyph and the thinking-block phrase+kind must co-occur
  // within ONE chrome block, not be scattered across the tail.
  for (let i = 0; i < tail.length; i++) {
    if (!ERROR_CHROME_RX.test(tail[i])) continue
    const block = tail.slice(i, i + ERROR_BLOCK_LINES).join('\n')
    if (ERROR_THINKING_PHRASE_RX.test(block) && ERROR_THINKING_KIND_RX.test(block)) {
      return true
    }
  }
  return false
}

/**
 * True when the live tail shows the Claude Code usage/session-limit menu.
 *
 * Two-tier match within the bottom LIMIT_MENU_TAIL_LINES:
 *   - the STRONG menu action line ("Stop and wait for limit to reset") alone,
 *     since it is UI chrome that cannot appear in natural reply prose -- this
 *     catches the truncated-viewport render where the limit phrase scrolled
 *     off-screen (card 732bb084); OR
 *   - a limit PHRASE together with a WEAK reset-time corroboration, so an agent
 *     that merely prints one limit phrase (or a bare reset time) in its reply
 *     prose is not misclassified.
 *
 * Scoped to the tail because the menu renders at the bottom, never in deep
 * scrollback. See token-outage-bridge.ts (LIMIT_PATTERNS) for the authoritative,
 * fuller matcher used by the separate token-free auto-ACK bridge; this inline
 * copy keeps pane-state.ts dependency-free.
 */
export function detectsUsageLimitMenu(pane: string): boolean {
  if (!pane) return false
  const tail = pane.split('\n').slice(-LIMIT_MENU_TAIL_LINES).join('\n')
  if (LIMIT_MENU_OPTION_RX.test(tail)) return true
  return LIMIT_PHRASE_RX.test(tail) && LIMIT_RESET_TIME_RX.test(tail)
}

export interface DetectPaneStateOptions {
  /** If true, the 'typing' state (text parked in input box) is
   * merged into 'busy'. Default false -- callers that care about
   * "user actively composing" vs "mid-turn" can distinguish. */
  mergeTypingAsBusy?: boolean
  /** Pane cursor position (0-indexed column,row), sampled with the same
   * capture via `tmux display-message -p '#{cursor_x},#{cursor_y}'`. When
   * provided, the parked-input check uses it to tell a real typed draft from
   * a dim ghost/autosuggestion drawn into an EMPTY composer (card c8d13cc0):
   * the TUI draws the suggestion to the RIGHT of the cursor, a real draft to
   * the LEFT. `tmux capture-pane -p` strips the dim attribute, so ghost and
   * draft are byte-identical in the string and the cursor column is the only
   * reliable, version-independent discriminator. Omitted -> the content-only
   * heuristic (PARKED_INPUT_RX) is used (safe legacy behaviour). */
  cursor?: { x: number; y: number }
}

/**
 * Classify a raw `tmux capture-pane -p` string into a pane state.
 *
 * Algorithm, in order:
 *   1. Empty / whitespace-only -> 'unknown'.
 *   2. Any BUSY_INDICATOR matches anywhere -> 'busy'. This includes the
 *      wider spinner/token-count fallbacks that catch the frame-level
 *      footer gap.
 *   2b. Usage/session-limit modal in the live tail -> 'busy'. Checked before
 *      the surface/idle returns so a limited session (which can render a box
 *      or idle-looking footer) is never treated as promptable.
 *   3. No idle footer visible -> 'unknown' (pane is not Claude Code).
 *   4. Wedged thinking-block API error in the live tail -> 'error'.
 *      Checked after the busy guard (a live turn is never 'error') and
 *      after the footer guard (an 'error' surface still shows the
 *      footer) so the scheduler/router stop injecting doomed prompts.
 *   5. Pending paste placeholder -> 'busy'.
 *   6. Text parked inside the bottom input box -> 'typing'.
 *   7. Otherwise -> 'idle'.
 */
export function detectPaneState(
  pane: string,
  opts: DetectPaneStateOptions = {},
): PaneState {
  if (!pane || !pane.trim()) return 'unknown'

  for (const rx of BUSY_INDICATORS) {
    if (rx.test(pane)) return 'busy'
  }

  // Usage/session-limit modal: never a promptable surface, even when it shows
  // a structural input box or an idle-looking footer. Checked before the
  // surface/idle/typing returns so the message-router and scheduler never
  // inject a prompt into a limited session (PR #130 DA review, HIGH).
  if (detectsUsageLimitMenu(pane)) return 'busy'

  // Surface recognition by POSITIVE input-affordance (card d978f8bd). 'idle'
  // (promptable) must be PROVEN by a live structural input box -- the two
  // box-separators framing a ❯ prompt, the affordance into which a prompt can
  // actually be typed. A recognised footer is NOT sufficient on its own: a
  // truncated viewport (box scrolled off), a mid-render frame, or a non-
  // promptable surface can carry an idle-looking footer with no live box, and
  // treating those as idle was the optimistic fall-through that let the
  // scheduler/router inject into a non-ready pane (RETRO #130 root finding).
  // A missing box -> 'unknown' (not-ready); the never-drop retry (#136) defers
  // rather than drops, and the abandon-rate metric (732bb084) watches the
  // false-BUSY cost. The box is also the footer-text-independent signal that
  // keeps channel-less rotating-tip-footer agents promptable (d3339db9).
  const lines = pane.split('\n')
  const box = findInputBoxBounds(lines)
  if (box === null) return 'unknown'

  if (detectsThinkingBlockError(pane)) return 'error'

  if (PENDING_PASTE_RX.test(pane)) return 'busy'

  // Text parked in the live input box -> 'typing'. The box is located
  // structurally (footer-text independent), so a parked draft is detected
  // even on the rotating-tip-footer surfaces. Scoped to the region between
  // the two bottom-most separators, so a historical ❯ in scrollback above
  // the box is never mistaken for live parked input.
  if (box !== null) {
    const inputLines = lines.slice(box.topSep + 1, box.bottomSep)
    const parkedLines = inputLines.filter(l => PARKED_INPUT_RX.test(l))
    if (parkedLines.length > 0) {
      // Cursor-aware ghost guard (card c8d13cc0): an empty composer showing
      // ONLY a dim autosuggestion is promptable, not a parked draft. Applied
      // only to the unambiguous single-parked-line shape with the cursor for
      // discrimination; a multi-line draft or absent cursor keeps the safe
      // 'typing' classification (a false-IDLE would concatenate into a draft).
      const ghostOnly =
        opts.cursor != null &&
        parkedLines.length === 1 &&
        isGhostSuggestionOnly(lines, box, opts.cursor)
      if (!ghostOnly) {
        return opts.mergeTypingAsBusy ? 'busy' : 'typing'
      }
    }
  }

  return 'idle'
}

/**
 * True when the pane is in the specific "accepting a new prompt" state.
 * 'typing' counts as not-ready because the user has unsubmitted text
 * in the input box and a new prompt would concatenate into it.
 */
export function isReadyForPrompt(pane: string): boolean {
  return detectPaneState(pane) === 'idle'
}

/**
 * True when a turn is ACTIVELY in progress -- a live spinner / token-stream
 * indicator is rendering RIGHT NOW. This is a strict subset of the coarse
 * 'busy' state: `detectPaneState` also returns 'busy' for a usage-limit menu
 * and for pending-paste stubs, neither of which is a running turn. Those are
 * explicitly excluded here.
 *
 * Why a dedicated predicate: it is the ONLY surface into which queued input is
 * safe to inject. Claude Code defers text typed during an active turn to the
 * next turn boundary (it never interrupts the in-flight tool call), so a
 * `/compact` queued here runs cleanly AFTER the current turn. A blocking
 * surface -- a permission dialog or a usage-limit menu -- STOPS the spinner, so
 * it cannot match BUSY_INDICATORS; gating on this predicate therefore guarantees
 * we never land an Enter on a dialog (the #130 false-ready failure class). Idle,
 * typing, unknown and error panes all return false (a running turn is the only
 * true case), so the existing idle-gated tiers keep sole ownership of their
 * surfaces.
 */
export function isActivelyWorking(pane: string): boolean {
  if (!pane || !pane.trim()) return false
  // A usage-limit menu is classified 'busy' by detectPaneState but is a
  // blocking modal, not a running turn -- never queue into it.
  if (detectsUsageLimitMenu(pane)) return false
  // A genuine in-flight turn shows a spinner / `(Ns · ↓ … tokens)` indicator.
  return BUSY_INDICATORS.some(rx => rx.test(pane))
}

// External state for idle-nudge classification. Cannot be derived from the
// pane string alone -- see detectsStalledIdle for the invariant that makes
// this external injection load-bearing.
export interface IdleNudgeContext {
  /**
   * True when the agent has at least one open obligation (an open kanban
   * card or an unacknowledged inter-agent message). This is the ONLY signal
   * that distinguishes a stalled session (e.g. "API Overloaded -> dropped to
   * idle without completing the task") from a genuinely done session at the
   * pane-capture level: both render an identical empty ❯ prompt.
   */
  hasOpenTask: boolean
}

/**
 * True when the pane is idle but the agent has an open task -- a state
 * that warrants an idle-nudge from the watchdog (card 845750ad).
 *
 * CRITICAL INVARIANT: "API Overloaded -> empty prompt" and "genuinely done
 * -> idle" are pane-capture IDENTICAL. Neither the busy indicators, the
 * footer text, nor the input box structure can distinguish them. The
 * distinguishing signal is entirely external: does the agent have a pending
 * obligation? The harness MUST inject context.hasOpenTask from the kanban /
 * message store rather than trying to infer it from the pane string.
 *
 * Three boundary cases (card 845750ad fixture corpus):
 *   [A] idle + hasOpenTask=true  -> true  (stalled, e.g. post-overload)
 *   [B] busy + hasOpenTask=true  -> false (mid-turn, not stalled)
 *   [C] idle + hasOpenTask=false -> false (genuinely done, no nudge)
 *
 * @param pane    The raw `tmux capture-pane -p` output.
 * @param context External agent state -- whether the agent has an open task.
 */
export function detectsStalledIdle(pane: string, context: IdleNudgeContext): boolean {
  return detectPaneState(pane) === 'idle' && context.hasOpenTask
}

// Locate the live Claude Code input box and return its inner content as
// one string. Bounded strictly to the region between the two most
// recent BOX_SEP_RX separators above the idle footer, so a parked input
// in scrollback (post-turn artifact) is never mistaken for live state.
//
// Returns null when the pane does not have a live input box (no idle
// footer, only one separator, etc.) -- callers should treat null as
// "not enough signal to act, do nothing".
function liveInputBox(pane: string): string | null {
  const lines = pane.split('\n')
  const box = findInputBoxBounds(lines)
  if (box === null) return null
  return lines.slice(box.topSep + 1, box.bottomSep).join('\n')
}

// Marker strings from prompt-safety.ts preambles. We do NOT import them
// to keep this module dependency-free for unit testing; the markers
// here are stable opening phrases pinned to the first sentence of each
// preamble. A prompt-safety.ts test pins the preamble shape so a rename
// will surface as a failing test there, not here.
//
// Each regex requires an extended opening fragment so prose that
// merely echoes the marker ("Let me search for TEAM MEMBER NOTICE in
// the logs", "SECURITY NOTICE -- read carefully before deploying")
// does not trigger a false-positive clear. The longer tail
// (`<trusted-peer source` / `before acting`) is unique enough that a
// random typed sentence is implausible to reproduce it verbatim.
// Whitespace classes (`\s+`) intentionally include newline so a
// terminal-wrapped preamble (TUI re-flow at narrow widths) still
// matches -- that wrapped preamble is the genuine article, not a
// false-positive.
const TRUSTED_PREAMBLE_MARKER = /TEAM MEMBER NOTICE\s+--\s+the next\s+<trusted-peer\s+source/
const UNTRUSTED_PREAMBLE_MARKER = /SECURITY NOTICE\s+--\s+read carefully before acting/

// A "real" opening tag has source="<alphanumeric/colon/underscore/dash>",
// because sanitizeAgentSource() (prompt-safety.ts) strips every other
// character. The preambles themselves reference the tag shape with
// source="..." (three literal full stops), which sanitizeAgentSource
// would scrub -- so a literal "..." source can only originate from the
// preamble text, never from a real wrapped message. Distinguishing on
// the source content is what lets us tell a stale preamble (no real
// tag yet) from a fully-landed message (real tag with a sanitised
// source).
const REAL_OPENING_TAG_RX = /<(?:trusted-peer|untrusted)\s+source="[A-Za-z0-9:_-]+"/

/**
 * Returns true when the pane likely has just-sent text sitting in the
 * Claude Code prompt buffer that the trailing Enter never submitted --
 * i.e. a stuck-after-send-keys state from which a retry-Enter is
 * warranted.
 *
 * Two stuck signatures are handled:
 *
 *   1. A `[Pasted text #N]` placeholder visible in the input box. Claude
 *      Code's bracketed-paste detector lifts long bursts of input into
 *      stubs that do not auto-submit on the trailing Enter. The
 *      placeholder shape is unambiguous, so any occurrence inside the
 *      live input box is treated as stuck.
 *
 *   2. A verbatim payload sitting in the input box. The detector
 *      requires `payloadHint` to be a substring of the live input box's
 *      content, so a parked input the operator typed manually is not
 *      mistaken for a stuck send. The minimum hint length is
 *      configurable via opts.minHintChars (default 16) to keep short
 *      hints from false-positiving on common UI text.
 *
 * Negative cases (returns false):
 *
 *   - The pane is busy (spinner / token counter / esc-to-interrupt) --
 *     the prompt is being processed, no retry needed.
 *   - The pane is not a Claude Code surface (no idle footer found).
 *   - The input box is empty and no paste placeholder is visible.
 *   - The verbatim path is requested but `payloadHint` is shorter than
 *     `minHintChars` (caller passed a too-short hint).
 *
 * @param pane The raw `tmux capture-pane -p` output to inspect.
 * @param payloadHint A substring of the prompt just sent. Used by the
 *   verbatim-detection path; pass an empty string to limit the check
 *   to the placeholder path only.
 * @param opts.minHintChars Minimum length the hint must reach before
 *   the verbatim path is attempted. Default 16.
 */
export function shouldRetrySubmit(
  pane: string,
  payloadHint: string,
  opts: { minHintChars?: number } = {},
): boolean {
  if (!pane || !pane.trim()) return false

  // Busy pane: the turn is mid-flight, no retry needed.
  for (const rx of BUSY_INDICATORS) {
    if (rx.test(pane)) return false
  }
  // Without a live input box the pane is either not Claude Code or in an
  // unknown render state -- be conservative and skip. The box is located
  // structurally (footer-text independent) so the retry path also covers
  // channel-less agents whose footer shows only a rotating tip (d3339db9).
  const inputBox = liveInputBox(pane)
  if (inputBox == null) return false

  // Path 1: placeholder is unambiguous, retry regardless of hint.
  if (PENDING_PASTE_RX.test(inputBox)) return true

  // Path 2: verbatim payload parked in the input box.
  // Clamp the minimum hint length to >= 1. minHintChars=0 paired with
  // an empty payloadHint would otherwise let `inputBox.includes("")`
  // return true for every non-empty box, retrying Enter on every idle
  // pane. Non-finite inputs (NaN, Infinity) fall back to the default
  // so a malformed caller can't silently disable or saturate the
  // verbatim path either.
  const rawMin = opts.minHintChars
  const safeMin = typeof rawMin === 'number' && Number.isFinite(rawMin) ? rawMin : 16
  const minHint = Math.max(safeMin, 1)
  if (payloadHint.length < minHint) return false
  return inputBox.includes(payloadHint)
}

/**
 * Returns true when the pane shows a stale preamble from a wrapped
 * message that never fully landed -- a `SECURITY NOTICE` (untrusted) or
 * `TEAM MEMBER NOTICE` (trusted-peer) preamble visible in the input
 * box without a matching real opening tag (`<untrusted source="...">`
 * or `<trusted-peer source="...">` with a sanitised source value).
 *
 * When this returns true the caller must issue a buffer-clear (Ctrl-U)
 * before sending the next message. Otherwise a fresh prompt would be
 * concatenated onto the stale preamble and the receiving agent could
 * inherit its trust semantics: e.g. an untrusted external payload
 * landing behind a stale `TEAM MEMBER NOTICE` preamble could be read
 * as if it came from a trusted peer.
 *
 * The check is scoped strictly to the live input box (between the two
 * most recent box-separators above the idle footer). A preamble in
 * deep scrollback (a long-ago turn's artifact) never triggers a clear.
 *
 * Distinguishing a stale preamble from a fully-landed message relies
 * on the source-attribute content: real wrapped messages always carry
 * a sanitised `source="agent:NAME"` (or similar) value, while the
 * preambles themselves only reference the tag shape with the literal
 * placeholder `source="..."`. The literal three full stops are
 * impossible to produce from `sanitizeAgentSource()`, so their
 * presence proves we are looking at preamble text rather than a real
 * opening tag.
 */
export function shouldClearTruncatedPreamble(pane: string): boolean {
  if (!pane) return false
  const inputBox = liveInputBox(pane)
  if (inputBox == null) return false

  const hasPreamble =
    TRUSTED_PREAMBLE_MARKER.test(inputBox) ||
    UNTRUSTED_PREAMBLE_MARKER.test(inputBox)
  if (!hasPreamble) return false

  // A real opening tag means the wrapped content landed -- not stuck.
  if (REAL_OPENING_TAG_RX.test(inputBox)) return false

  return true
}

export type SubmitFollowupAction = 'retry-enter' | 'done' | 'give-up'

/**
 * Decide what the post-send-keys loop should do next, given the
 * current pane snapshot and how many retry-Enter attempts have already
 * been made. Returns one of three discrete actions so the caller can
 * branch without re-running the detection logic itself.
 *
 *   - 'done'        -- the prompt landed (or the pane is busy
 *                      processing); no further action.
 *   - 'retry-enter' -- the pane shows a stuck send; send another Enter
 *                      and re-sample.
 *   - 'give-up'     -- the retry budget is spent, or the capture failed
 *                      and we cannot tell whether retry would help.
 *                      Caller should log a warning and move on.
 *
 * Splitting the decision out as pure logic keeps the I/O-bound loop in
 * src/web/agent-process.ts trivially testable without mocking tmux or
 * child_process: feed snapshot strings + attempt counters in, assert
 * the action out.
 *
 * @param pane         The most recent capture-pane snapshot, or null
 *                     if the capture itself failed.
 * @param payloadHint  Substring of the just-sent prompt, used for the
 *                     verbatim-stuck detection path. Pass empty to
 *                     restrict detection to the placeholder path.
 * @param attempt      How many retry-Enters have ALREADY been sent
 *                     (0 on the first decision after the initial send).
 * @param maxAttempts  How many retry-Enters the caller is willing to
 *                     send total. The decision returns 'give-up' once
 *                     attempt >= maxAttempts and the pane is still
 *                     stuck.
 */
export function decideSubmitFollowup(
  pane: string | null,
  payloadHint: string,
  attempt: number,
  maxAttempts: number,
): SubmitFollowupAction {
  if (pane == null) return 'give-up'
  if (!shouldRetrySubmit(pane, payloadHint)) return 'done'
  if (attempt >= maxAttempts) return 'give-up'
  return 'retry-enter'
}

export interface PaneErrorAlertState {
  /** When the session was first observed in the error state during the
   * current spell, or null when there is no active spell. */
  firstSeenAt: number | null
  /** When the last alert was sent for this session, or null if never. */
  lastAlertAt: number | null
  /** When the session was last observed in the error state. Used to
   * keep a spell alive across brief non-error blips (a flapping
   * capture, or a busy spinner mid-flight) so the confirm window is
   * not reset to zero by a single non-error tick. */
  lastErrorAt: number | null
}

export interface PaneErrorAlertThresholds {
  /** How long the session must stay in error before the first alert, so
   * a transient one-tick error that clears on its own is not reported. */
  confirmMs: number
  /** Minimum gap between repeated alerts within one unbroken error
   * spell, so a wedged session does not alert on every monitor tick. */
  dedupMs: number
  /** How long the session must be continuously error-free before an
   * active spell is cleared. A single non-error tick (null capture, a
   * mid-flight busy spinner) must NOT reset the spell, otherwise a
   * genuinely wedged but flapping session never reaches the confirm
   * window and never alerts. */
  clearMs: number
}

export interface PaneErrorAlertDecision {
  alert: boolean
  next: PaneErrorAlertState
}

/**
 * Pure state machine for "should the monitor alert that this session is
 * wedged in the thinking-block error". Dependency-free so it is
 * unit-testable without tmux or timers: feed the current error
 * observation, the previous persisted state and a clock, get back the
 * alert decision plus the next state to persist.
 *
 * Deliberately ALERT-only -- it never decides to reset or restart a
 * session. Auto-reset destroys the agent's in-context working memory,
 * and while the deep trigger is not fully understood a false positive
 * must not nuke a healthy agent. A human (or the hub agent) acts on the
 * alert. Guards that keep it quiet: the first sighting only records
 * (never alerts, so an error must be seen on at least two ticks even
 * when confirmMs is 0), a confirm window (the error must persist), and a
 * dedup window (one alert per spell, not per tick). A non-error tick
 * does NOT immediately end a spell -- it ends only after clearMs of
 * continuous error-free time, so a flapping capture (null / mid-flight
 * busy between error frames) cannot starve the confirm window. A
 * future-dated stored timestamp (wall-clock skew, NTP correction)
 * restarts the spell instead of stalling the deltas negative.
 */
export function decidePaneErrorAlert(
  isError: boolean,
  prev: PaneErrorAlertState,
  now: number,
  thresholds: PaneErrorAlertThresholds,
): PaneErrorAlertDecision {
  if (!isError) {
    // No active spell: nothing to track.
    if (prev.firstSeenAt === null) {
      return { alert: false, next: { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null } }
    }
    // Active spell: clear only after a sustained error-free gap, so a
    // single flapping non-error tick does not reset the confirm window.
    // A future-dated lastErrorAt (clock skew) counts as "clear now".
    const errorFreeFor = prev.lastErrorAt === null ? Infinity : now - prev.lastErrorAt
    if (errorFreeFor >= thresholds.clearMs || errorFreeFor < 0) {
      return { alert: false, next: { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null } }
    }
    // Hold the spell unchanged.
    return { alert: false, next: { ...prev } }
  }
  // First sighting in this spell: record only, never alert. Guarantees
  // at least two observations before any alert, independent of confirmMs.
  if (prev.firstSeenAt === null) {
    return { alert: false, next: { firstSeenAt: now, lastAlertAt: prev.lastAlertAt, lastErrorAt: now } }
  }
  // Clock skew: a stored timestamp in the future relative to now would
  // drive the deltas negative and stall the machine silently. Restart
  // the spell from now and drop the stale alert time.
  if (now < prev.firstSeenAt || (prev.lastAlertAt !== null && now < prev.lastAlertAt)) {
    return { alert: false, next: { firstSeenAt: now, lastAlertAt: null, lastErrorAt: now } }
  }
  const sustained = now - prev.firstSeenAt >= thresholds.confirmMs
  if (!sustained) {
    return { alert: false, next: { firstSeenAt: prev.firstSeenAt, lastAlertAt: prev.lastAlertAt, lastErrorAt: now } }
  }
  const dedupElapsed = prev.lastAlertAt === null || now - prev.lastAlertAt >= thresholds.dedupMs
  if (dedupElapsed) {
    return { alert: true, next: { firstSeenAt: prev.firstSeenAt, lastAlertAt: now, lastErrorAt: now } }
  }
  return { alert: false, next: { firstSeenAt: prev.firstSeenAt, lastAlertAt: prev.lastAlertAt, lastErrorAt: now } }
}

// A stable signature of the text parked in the live input box, or null
// when the pane is not in the 'typing' (parked-input) state.
//
// Used by the stuck-input watcher to decide whether a swallowed Enter on
// the channel-notification path left a message stranded in the prompt
// box. Whitespace is collapsed so a cursor blink or a terminal re-flow at
// a different width does not read as "new text" and reset the recovery
// confirm window. Returns null (not an empty string) when there is no
// parked text so callers can branch on "is anything parked at all".
export function stuckInputSignature(pane: string): string | null {
  if (detectPaneState(pane) !== 'typing') return null
  const box = liveInputBox(pane)
  if (box == null) return null
  const sig = box.replace(/\s+/g, ' ').trim()
  return sig.length > 0 ? sig : null
}

// A stable signature of a `[Pasted text #N]` placeholder parked in the live
// input box, or null when there is no recoverable stale-paste stall.
//
// detectPaneState classifies a pending-paste placeholder as 'busy' (an
// injection-avoidance measure: the scheduler must not pile prompts onto a
// parked paste), so stuckInputSignature -- which only fires for the 'typing'
// state -- never sees it. That left a real failure mode uncovered (card
// 1b0f58ba): when the closing Enter is swallowed on the channel-notification
// path, the pasted payload sits parked indefinitely and only the bounded
// post-send retry in sendPromptToSession could ever recover it (a ~1s window).
// This signature feeds the same decideStuckInputRecovery machinery so the
// stuck-input watcher can re-submit a genuinely stalled paste.
//
// Returns null (no recovery) unless ALL of these hold, so it never fires on a
// pane that is legitimately busy or still receiving input:
//   - the pane is NOT actively working -- no live spinner / token stream. A
//     spinner alongside the placeholder means the turn is really processing
//     the paste, so an Enter would land mid-turn (adversarial fixture c).
//   - the pane is NOT a usage-limit modal -- that is a real blocking surface
//     owned by the usage-limit handlers, not a swallowed-Enter stall.
//   - there IS a live input box and the placeholder is inside it -- a
//     `[Pasted text]` echo left in scrollback is not live parked input.
//
// The signature is the whitespace-collapsed input box, so a growing burst
// (the char count climbs, or a second placeholder appears between polls)
// yields a different signature and the watcher's confirm window restarts
// rather than recovering prematurely (adversarial fixture b).
export function pendingPasteSignature(pane: string): string | null {
  if (!pane || !pane.trim()) return null
  if (isActivelyWorking(pane)) return null
  if (detectsUsageLimitMenu(pane)) return null
  const box = liveInputBox(pane)
  if (box == null) return null
  if (!PENDING_PASTE_RX.test(box)) return null
  const sig = box.replace(/\s+/g, ' ').trim()
  return sig.length > 0 ? sig : null
}

// Per-session bookkeeping for the stuck-input recovery watcher. A "spell"
// is one continuous stretch of the SAME text parked in the input box.
export interface StuckInputState {
  /** Signature of the parked text for the active spell, or null when no
   * spell is active (the box is empty / the pane is busy). */
  parkedSig: string | null
  /** When the active spell was first observed. */
  firstSeenAt: number | null
  /** When the last recovery Enter was sent in this spell, or null. */
  lastRecoverAt: number | null
  /** How many recovery Enters have been sent in the active spell. */
  attempts: number
}

export interface StuckInputThresholds {
  /** How long the SAME text must stay parked before the first recovery
   * Enter, so a turn that is about to submit on its own (frame race) is
   * not pre-empted and a human mid-typing is left alone. */
  confirmMs: number
  /** Minimum gap between recovery Enters within one spell, so a pane
   * that ignores the Enter is not hammered every tick. */
  dedupMs: number
  /** Max recovery Enters per spell before giving up (caller logs). A
   * pane still stuck after this is not the swallowed-Enter case the
   * watcher targets; further Enters would not help. */
  maxAttempts: number
}

export interface StuckInputDecision {
  recover: boolean
  next: StuckInputState
}

const NO_STUCK_INPUT: StuckInputState = {
  parkedSig: null,
  firstSeenAt: null,
  lastRecoverAt: null,
  attempts: 0,
}

/**
 * Pure decision for "should the watcher send a recovery Enter to this
 * session". Dependency-free so it is unit-testable without tmux or
 * timers: feed the current parked-input signature (from
 * stuckInputSignature), the previous persisted state and a clock, get
 * back whether to send Enter plus the next state to persist.
 *
 * The channel-notification path (inbound Telegram/Slack delivered by the
 * plugin) does not go through sendPromptToSession, so its post-send
 * Enter-retry budget cannot cover a swallowed Enter there. This watcher
 * is the backstop: it detects the symptom (text stranded in the prompt
 * box) and re-submits.
 *
 * Guards that keep it from firing on healthy panes:
 *   - A new or CHANGED parked signature restarts the confirm window
 *     (record-only), so text that is still arriving / being edited and a
 *     turn that submits on its own are never pre-empted. With confirmMs
 *     > 0 this also guarantees at least two observations before any Enter.
 *   - A confirm window: the same text must persist for confirmMs.
 *   - A dedup window between Enters, and a maxAttempts cap per spell.
 *   - Backwards clock skew (a future stored timestamp) restarts the
 *     spell instead of stalling the deltas negative.
 *
 * @param parkedSig   Signature of the parked input now, or null when the
 *                    pane is not in the parked-input state.
 * @param prev        Previously persisted state for this session.
 * @param now         Current clock (ms).
 * @param thresholds  Confirm / dedup / maxAttempts knobs.
 */
export function decideStuckInputRecovery(
  parkedSig: string | null,
  prev: StuckInputState,
  now: number,
  thresholds: StuckInputThresholds,
): StuckInputDecision {
  // Nothing parked: end any active spell.
  if (parkedSig === null) {
    return { recover: false, next: { ...NO_STUCK_INPUT } }
  }
  // New spell, or the parked text changed (still arriving / edited /
  // a different message): restart the confirm window, record only.
  if (prev.parkedSig !== parkedSig || prev.firstSeenAt === null) {
    return { recover: false, next: { parkedSig, firstSeenAt: now, lastRecoverAt: null, attempts: 0 } }
  }
  // Backwards clock skew: a stored timestamp in the future relative to
  // now would drive the deltas negative and stall. Restart the spell.
  if (now < prev.firstSeenAt || (prev.lastRecoverAt !== null && now < prev.lastRecoverAt)) {
    return { recover: false, next: { parkedSig, firstSeenAt: now, lastRecoverAt: null, attempts: 0 } }
  }
  // Retry budget spent: hold without acting.
  if (prev.attempts >= thresholds.maxAttempts) {
    return { recover: false, next: { ...prev } }
  }
  // Confirm window not yet elapsed.
  if (now - prev.firstSeenAt < thresholds.confirmMs) {
    return { recover: false, next: { ...prev } }
  }
  // Dedup gap between recovery Enters.
  if (prev.lastRecoverAt !== null && now - prev.lastRecoverAt < thresholds.dedupMs) {
    return { recover: false, next: { ...prev } }
  }
  return {
    recover: true,
    next: { parkedSig, firstSeenAt: prev.firstSeenAt, lastRecoverAt: now, attempts: prev.attempts + 1 },
  }
}

// =============================================================================
// Stuck tool-call watcher (2026-06-02 incident, Worked-for >Ns freeze)
// =============================================================================
//
// Symptom: Marveen's TUI shows "Worked for 31s" (or "Brewed for", "Baked for")
// indefinitely. The claude process is at 0.3% CPU (IO-wait, no progress), bun
// poller is alive, hasChannelPluginAlive() returns true -- so the recovery
// cascade gated on bun absence (#240) never fires. Real cause: the Telegram
// reply tool-call hung server-side without a client-side timeout, taking the
// TUI render loop with it.
//
// Detection: parse the `Worked for Ns` line. If the SAME tag+seconds is
// observed across `confirmPolls` consecutive polls AND `seconds >= freezeSeconds`,
// the tool-call is frozen and the session needs a hard restart. The tag must
// stay the same too (different verb / restart of the counter means progress).

/**
 * Parse the TUI's "Worked / Brewed / Baked / Cooking / Simmered for Ns"
 * footer if present. Returns null when the pane is not in a tool-call
 * waiting state (no tool-call line, or it just changed verb).
 *
 * The verb is part of the signature so that a TUI transition from "Brewed"
 * to "Worked" -- which actually IS progress, the tool-call moved to a new
 * phase -- resets the stuck-spell.
 */
export interface ToolCallProgressSignature {
  tag: string
  seconds: number
}

const TOOL_CALL_PROGRESS_RX = /(?:✻\s*)?(Worked|Brewed|Baked|Cooking|Simmered|Sauteed|Sauted)\s+for\s+(\d+)s/i

export function stuckToolCallSignature(pane: string): ToolCallProgressSignature | null {
  const m = pane.match(TOOL_CALL_PROGRESS_RX)
  if (!m) return null
  const tag = m[1]!.toLowerCase()
  const seconds = parseInt(m[2]!, 10)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return { tag, seconds }
}

export interface StuckToolCallState {
  /** Current tool-call tag we are watching (e.g. "worked"), or null if no spell active. */
  tag: string | null
  /** The seconds value observed when the spell started -- preserved for the
   * audit log so an operator can tell at what counter value the freeze happened. */
  spellStartSeconds: number | null
  /** When the spell was first observed (ms). */
  firstSeenAt: number | null
  /** Last observed seconds value, used to detect stagnation across polls. */
  lastSeconds: number | null
  /** Consecutive polls in which the seconds value did NOT increase. */
  stagnantPolls: number
  /** Wall-clock timestamp (ms) at which the counter first stopped advancing
   * in this spell, or null if the counter is currently progressing. This is
   * the load-bearing measurement for the freeze decision: a wedged TUI keeps
   * displaying the same `<verb> for Ns` regardless of real time, so we
   * measure freeze duration in WALL CLOCK from stagnantSince, NOT from the
   * displayed counter value. (PR #246 review fix, 2026-06-02: the prior
   * version gated on sig.seconds >= freezeSeconds and so could never fire on
   * a counter frozen at <180s -- exactly the 2026-06-02 06:41 incident shape
   * where it sat at 31s.) */
  stagnantSince: number | null
  /** Recoveries fired in this spell (cap at 1 -- a respawn is the only
   * action, and the next sweep observes the new pane fresh). */
  attempts: number
}

export interface StuckToolCallThresholds {
  /** How long the TUI counter must remain stagnant in WALL-CLOCK terms
   * before we conclude the render loop is wedged. A healthy long-running
   * tool-call increments the counter every TUI redraw (~once per second),
   * so a counter that holds the same value for >= this many ms is wedged
   * regardless of what value it holds. The previous "displayed-value
   * threshold" reading was the PR #246 review bug. */
  freezeSeconds: number
  /** How many consecutive polls of NON-INCREASING seconds count as
   * "the TUI render loop is wedged" (anti-fluke). A real tool-call
   * increments every TUI redraw, so multi-poll stagnation is conclusive.
   * Composed WITH the wall-clock freezeSeconds check -- BOTH must hold. */
  stagnantPolls: number
}

export interface StuckToolCallDecision {
  recover: boolean
  next: StuckToolCallState
}

const NO_STUCK_TOOL_CALL: StuckToolCallState = {
  tag: null,
  spellStartSeconds: null,
  firstSeenAt: null,
  lastSeconds: null,
  stagnantPolls: 0,
  stagnantSince: null,
  attempts: 0,
}

/**
 * Pure decision: should the watcher respawn this session because the TUI
 * tool-call counter has stopped advancing for too long?
 *
 * Load-bearing measurement is WALL-CLOCK stagnation duration, NOT the
 * displayed counter value. A wedged TUI keeps showing the same
 * `<verb> for Ns` regardless of real time; gating on `sig.seconds >=
 * freezeSeconds` (PR #246 review bug, 2026-06-02) would miss exactly the
 * incident shape the watchdog is built for (counter frozen at 31s, never
 * reaches 180s, never recovers).
 *
 * Guards against false positives on legitimate long tool-calls:
 *   - Wall-clock stagnation `(now - stagnantSince) >= freezeSeconds`. A
 *     healthy long-running call increments the counter every TUI redraw,
 *     so stagnantSince keeps resetting to null and the duration never
 *     accumulates. A wedged TUI lets it accumulate.
 *   - Anti-fluke: stagnantPolls >= thresholds.stagnantPolls (two
 *     consecutive non-incrementing observations), composed AND with the
 *     wall-clock check.
 *   - Recovery is one-shot per spell (attempts cap at 1). The next sweep
 *     reads a fresh pane after the respawn.
 *   - A tag change (e.g. Brewed -> Worked) or counter increment resets
 *     the spell -- both are genuine progress.
 */
export function decideStuckToolCallRecovery(
  sig: ToolCallProgressSignature | null,
  prev: StuckToolCallState,
  now: number,
  thresholds: StuckToolCallThresholds,
): StuckToolCallDecision {
  // No tool-call line: end any spell.
  if (sig === null) {
    return { recover: false, next: { ...NO_STUCK_TOOL_CALL } }
  }
  // Spell start, OR tag changed (a verb change is genuine progress).
  if (prev.tag !== sig.tag || prev.firstSeenAt === null) {
    return {
      recover: false,
      next: {
        tag: sig.tag,
        spellStartSeconds: sig.seconds,
        firstSeenAt: now,
        lastSeconds: sig.seconds,
        stagnantPolls: 0,
        stagnantSince: null,
        attempts: 0,
      },
    }
  }
  // Backwards clock skew: restart the spell rather than stall.
  if (now < prev.firstSeenAt || (prev.stagnantSince !== null && now < prev.stagnantSince)) {
    return {
      recover: false,
      next: {
        tag: sig.tag,
        spellStartSeconds: sig.seconds,
        firstSeenAt: now,
        lastSeconds: sig.seconds,
        stagnantPolls: 0,
        stagnantSince: null,
        attempts: 0,
      },
    }
  }
  // Counter advanced: real progress. Reset both the stagnant-poll counter
  // and the stagnantSince timestamp -- the TUI is alive. Keep the spell
  // open with the same tag so a LATER freeze is detected without re-running
  // the full freezeSeconds window from scratch (the wall-clock measurement
  // restarts from the next stagnation onward, which is the right thing).
  if (prev.lastSeconds !== null && sig.seconds > prev.lastSeconds) {
    return {
      recover: false,
      next: { ...prev, lastSeconds: sig.seconds, stagnantPolls: 0, stagnantSince: null },
    }
  }
  // Counter stagnant (same or rolled-back). Tick the stagnant counter and
  // stamp stagnantSince on the FIRST stagnant observation in this stretch.
  // Subsequent stagnant polls preserve the original stagnantSince so the
  // wall-clock duration accumulates correctly.
  const nextStagnant = prev.stagnantPolls + 1
  const nextStagnantSince = prev.stagnantSince ?? now
  // Recovery already fired in this spell: hold.
  if (prev.attempts >= 1) {
    return {
      recover: false,
      next: { ...prev, lastSeconds: sig.seconds, stagnantPolls: nextStagnant, stagnantSince: nextStagnantSince },
    }
  }
  // Recover only when BOTH gates hold: wall-clock freeze duration AND
  // anti-fluke poll count. A 5-minute genuine tool-call resets
  // stagnantSince on every redraw, so even though the call is long this
  // duration never accumulates.
  const stagnantMs = now - nextStagnantSince
  const freezeMs = thresholds.freezeSeconds * 1000
  if (stagnantMs < freezeMs || nextStagnant < thresholds.stagnantPolls) {
    return {
      recover: false,
      next: { ...prev, lastSeconds: sig.seconds, stagnantPolls: nextStagnant, stagnantSince: nextStagnantSince },
    }
  }
  return {
    recover: true,
    next: { ...prev, lastSeconds: sig.seconds, stagnantPolls: nextStagnant, stagnantSince: nextStagnantSince, attempts: 1 },
  }
}
