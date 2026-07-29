import { execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, CHANNEL_PROVIDER } from '../config.js'
import { readAgentChannelProviderSafe } from './agent-config.js'
import { agentSessionName, capturePane, isSessionReadyForPrompt } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { getProvider, type ChannelProviderType } from '../channel-provider.js'

const TMUX = resolveFromPath('tmux')
const MAX_UP_ATTEMPTS = 8

// Aggressive idle-catch window (card fa3f5012 slice-2). A single
// isSessionReadyForPrompt() snapshot misses the brief idle BEAT a busy agent
// returns to between tool calls, so a continuously-working agent (e.g. an
// always-generating PA) deferred forever and its dead pipe never self-healed.
// We instead SAMPLE readiness a few times over a short window to catch that beat
// at a tool boundary. Kept small so a genuinely stuck-busy pane still defers
// within a couple of seconds (the health monitor's escalation is the backstop).
const IDLE_CATCH_ATTEMPTS = 6
const IDLE_CATCH_GAP_MS = 500

export interface ReconnectResult {
  ok: boolean
  message: string
  // true when we backed off because the pane stayed busy through the whole
  // idle-catch window -- a DEFERRAL, not a drive failure. Callers use this to
  // avoid burning the reconnect-retry budget on a busy pane and to escalate a
  // persistently-stuck-busy agent to the operator instead (channel-health-monitor).
  deferred?: boolean
}

/**
 * Poll for a momentary idle window at a tool boundary. Returns true as soon as
 * the pane reports ready, false if it stayed busy for the whole window. The
 * inter-poll sleep is an off-pane `/bin/sleep` (never a keystroke), so this is
 * wedge-safe even against a busy pane -- it observes, it does not touch.
 */
export function pollForIdleWindow(
  session: string,
  attempts: number = IDLE_CATCH_ATTEMPTS,
  gapMs: number = IDLE_CATCH_GAP_MS,
): boolean {
  for (let i = 0; i < attempts; i++) {
    if (isSessionReadyForPrompt(session)) return true
    if (i < attempts - 1) {
      try {
        execFileSync('/bin/sleep', [String(gapMs / 1000)], { timeout: gapMs + 1000 })
      } catch { /* best effort -- a failed sleep just tightens the poll cadence */ }
    }
  }
  return false
}

export function resolveAgentSession(agentName: string): string {
  if (agentName === MAIN_AGENT_ID) return MAIN_CHANNELS_SESSION
  return agentSessionName(agentName)
}

export function resolveAgentProviderType(agentName: string): ChannelProviderType {
  // Fail-soft on an unreadable config (misconfigured secret pointer) -> default.
  const perAgent = readAgentChannelProviderSafe(agentName).provider
  if (perAgent === 'slack' || perAgent === 'telegram') return perAgent
  return CHANNEL_PROVIDER
}

function getPluginPattern(providerType: ChannelProviderType): RegExp {
  const provider = getProvider(providerType)
  const escaped = provider.pluginPaneId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped, 'i')
}

// Max Down presses we'll spend trying to land the cursor on the target
// option inside the plugin submenu.
const SUBMENU_MAX_STEPS = 6
const RECONNECT_RX = /reconnect/i
// Word-anchored so it never matches the "Disable" option (which we must
// never activate). "Disable" contains no "enable" substring anyway, but the
// boundary keeps intent explicit.
const ENABLE_RX = /\benable\b/i
// Plugin-state markers Claude Code renders in the submenu header line
// `Status: <glyph> <word>`. We use the STATUS as authoritative when present,
// because scanning the whole pane for "reconnect"/"enable" is fragile in two
// ways: (a) Claude Code's own footer line ("Use /mcp to reconnect") triggers
// a false RECONNECT match even for disabled plugins; (b) action labels can
// change order across CC versions. Status text is rendered once, plugin-
// header-line, and is the ground truth for what action menu is offered.
//   ✔ connected -> View tools / Reconnect / Disable
//   ✗ failed    -> Reconnect / ...
//   ◯ disabled  -> Enable
// The ◯ vs ○ ambiguity is real (Claude Code has shipped both); match either.
const DISABLED_STATUS_RX = /Status:\s*[◯○]\s*disabled/i
const FAILED_STATUS_RX = /Status:\s*[✗x×]\s*failed/i
// Claude Code's TUI marks the selected list row with a `❯` cursor (same glyph
// the input prompt uses -- see pane-state.ts). capture-pane -p strips colour,
// so this textual marker is our only selection signal.
const POINTER_RX = /❯/
// A numbered submenu OPTION row under the cursor: `❯ 1. View tools`. This is
// the unambiguous shape Claude Code renders for every action row (1.View tools
// 2.Reconnect 3.Disable / 1.Reconnect / 1.Enable). The `N.` is what separates a
// real menu cursor from a stray `❯` in the scrollback -- see selectedSubmenuLine.
const MENU_OPTION_CURSOR_RX = /❯\s*\d+\.\s/

/**
 * The submenu row currently marked with the `❯` cursor, or null.
 *
 * `capture-pane -p` includes the scrollback ABOVE the open menu, and the
 * agent's own input line (`❯ <queued text>`) plus transcript prompts carry the
 * SAME `❯` glyph. Returning the FIRST `❯` therefore grabbed that scrollback
 * line instead of the menu cursor, so the step-loop never saw the cursor reach
 * Reconnect/Enable and exhausted its budget ("Could not select reconnect within
 * N steps" -- card 8b07e17b, observed once the /mcp menu started rendering the
 * status inline on the top-level row and pushed the prompt into the capture).
 *
 * Resolution order:
 *   1. The numbered option cursor (`❯ 1. ...`) -- unambiguous in current Claude
 *      Code; a scrollback/input `❯` never carries the `N.` prefix.
 *   2. Fallback (unnumbered menus / older CC): the menu renders at the BOTTOM
 *      of the pane, below any scrollback, so the LAST `❯` line is the cursor.
 */
export function selectedSubmenuLine(pane: string): string | null {
  const lines = pane.split('\n')
  for (const raw of lines) {
    if (MENU_OPTION_CURSOR_RX.test(raw)) return raw
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (POINTER_RX.test(lines[i])) return lines[i]
  }
  return null
}

/**
 * Pick which action to drive in the plugin submenu based on what the pane
 * offers. Authoritative source is the `Status: <glyph> <word>` header that
 * Claude Code renders for every plugin in the submenu -- because scanning
 * for the option labels themselves false-positives on CC's own footer text
 * ("Use /mcp to reconnect", etc.) and pulled stage-1 onto Reconnect even
 * for disabled plugins (2026-06-01 20:02 incident: "could not place cursor
 * on target option ... target: reconnect" while the plugin was actually
 * `◯ disabled` and only an Enable row existed).
 *
 *   ◯ disabled -> Enable
 *   ✗ failed   -> Reconnect
 *   ✔ connected -> Reconnect (View tools is safe, Disable is forbidden)
 *
 * Returns null when neither status nor option label is found -- in that
 * case we must NOT press anything, because the remaining option could be
 * "Disable".
 */
export function chooseSubmenuTarget(pane: string): RegExp | null {
  // Status-first: ground truth, immune to footer false-positives.
  if (DISABLED_STATUS_RX.test(pane)) return ENABLE_RX
  if (FAILED_STATUS_RX.test(pane)) return RECONNECT_RX
  // Fallback: status header absent (older CC versions or partial captures).
  // Prefer Reconnect -- if the plugin were truly disabled it would not
  // expose a Reconnect row, so seeing one means we are NOT disabled.
  if (RECONNECT_RX.test(pane)) return RECONNECT_RX
  if (ENABLE_RX.test(pane)) return ENABLE_RX
  return null
}

/**
 * Attempt to reconnect a channel MCP plugin by navigating the /mcp
 * menu in the agent's tmux session. Generalises the existing
 * softReconnectMarveen() logic to any agent.
 *
 * Sequence: Escape → /mcp Enter → Up×N until plugin found → Enter →
 * step the `❯` cursor onto "Reconnect" (or "Enable" when disabled),
 * verifying after each step → Enter → Escape.
 *
 * The submenu option order is STATE-DEPENDENT in Claude Code 2.1.x:
 *   connected: 1.View tools  2.Reconnect  3.Disable
 *   failed:    1.Reconnect   ...
 *   disabled:  1.Enable
 * The previous logic blindly pressed Down+Enter, assuming "Reconnect" was
 * always one row down -- true only while connected. In the failed state that
 * landed on "Disable" and DISABLED the plugin, which then offered only
 * "Enable" and broke every subsequent retry ("submenu not found"). We now
 * read the menu and only press Enter once the cursor is confirmed on a safe
 * target.
 */
export function attemptChannelMcpReconnect(agentName: string): ReconnectResult {
  const session = resolveAgentSession(agentName)
  const providerType = resolveAgentProviderType(agentName)
  const pluginPattern = getPluginPattern(providerType)

  try {
    // Pane-idle pre-flight gate. Two purposes:
    //   1. SERIALISE concurrent drivers (the strong guarantee): a driver that
    //      arrives while another is already mid-/mcp-nav sees the open menu --
    //      NOT the idle footer -- so it backs off. This is what lets the
    //      dashboard-boot recovery (recoverOrchestratorPipeOnce) and the
    //      standalone 5-min watchdog coexist without ever double-driving the
    //      same pane (itself a wedge cause).
    //   2. Avoid driving keys while the agent is ACTIVELY generating, where an
    //      Escape would interrupt its turn.
    // Honest scope: detectPaneState reliably flags active streaming but can read
    // 'idle' during the brief pre-stream "thinking" phase (verified on Buster,
    // CC 2.1.160). Empirically that same CC absorbs stray /mcp keystrokes
    // without wedging (the nav just fails gracefully), so this gate is
    // defense-in-depth + serialisation, not an absolute interrupt-prevention.
    // A dead pipe does not need INSTANT recovery: if not idle, abort and let the
    // next cycle retry once the pane has settled.
    // Aggressive idle-catch: sample readiness across a short window so a busy
    // agent's tool-boundary beat is caught instead of deferred forever (the old
    // single snapshot). Only after the whole window stays busy do we defer -- and
    // we flag it as a DEFERRAL so the caller escalates a stuck-busy agent rather
    // than silently retrying into a 30-min cooldown (card fa3f5012 slice-2).
    if (!pollForIdleWindow(session)) {
      logger.warn({ agentName, session }, 'channel-mcp-reconnect: pane stayed busy through idle-catch window -- deferring /mcp drive')
      return { ok: false, message: 'Pane not idle (busy/unknown) -- deferred /mcp drive', deferred: true }
    }

    execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['1'], { timeout: 2000 })

    execFileSync(TMUX, ['send-keys', '-t', session, '/mcp', 'Enter'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['1'], { timeout: 3000 })

    const pane1 = capturePane(session)
    if (!pane1) {
      logger.warn({ agentName, session }, 'channel-mcp-reconnect: capture failed after /mcp')
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      return { ok: false, message: 'Failed to capture pane after /mcp' }
    }

    let matchedAt = -1
    for (let upCount = 1; upCount <= MAX_UP_ATTEMPTS; upCount++) {
      execFileSync(TMUX, ['send-keys', '-t', session, 'Up'], { timeout: 3000 })
      execFileSync('/bin/sleep', ['0.2'], { timeout: 1000 })
      execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 3000 })
      execFileSync('/bin/sleep', ['1'], { timeout: 3000 })

      const pane = capturePane(session)
      if (pane && pluginPattern.test(pane)) {
        matchedAt = upCount
        break
      }
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      execFileSync('/bin/sleep', ['0.5'], { timeout: 1000 })
    }

    if (matchedAt < 0) {
      logger.warn(
        { agentName, session, maxUpAttempts: MAX_UP_ATTEMPTS, pluginPattern: pluginPattern.source },
        'channel-mcp-reconnect: plugin submenu not found',
      )
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      return { ok: false, message: `Plugin not found within ${MAX_UP_ATTEMPTS} Up attempts` }
    }

    // Inside the plugin submenu now. Drive the cursor onto a safe action
    // ("Reconnect", or "Enable" when disabled) and only press Enter once it
    // is confirmed there -- never blindly, which previously hit "Disable".
    let submenu = capturePane(session)
    if (!submenu) {
      logger.warn({ agentName, session }, 'channel-mcp-reconnect: capture failed in submenu')
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      return { ok: false, message: 'Failed to capture submenu pane' }
    }

    const target = chooseSubmenuTarget(submenu)
    if (!target) {
      logger.warn({ agentName, session }, 'channel-mcp-reconnect: no Reconnect/Enable option in submenu')
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      return { ok: false, message: 'No Reconnect/Enable option in submenu' }
    }

    let onTarget = false
    for (let step = 0; step <= SUBMENU_MAX_STEPS; step++) {
      const sel = selectedSubmenuLine(submenu)
      if (sel && target.test(sel)) {
        onTarget = true
        break
      }
      execFileSync(TMUX, ['send-keys', '-t', session, 'Down'], { timeout: 3000 })
      execFileSync('/bin/sleep', ['0.3'], { timeout: 1000 })
      submenu = capturePane(session) ?? ''
    }

    if (!onTarget) {
      logger.warn(
        { agentName, session, target: target.source, maxSteps: SUBMENU_MAX_STEPS },
        'channel-mcp-reconnect: could not place cursor on target option',
      )
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      return { ok: false, message: `Could not select ${target.source} within ${SUBMENU_MAX_STEPS} steps` }
    }

    execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
    execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })

    const action = target === RECONNECT_RX ? 'Reconnect' : 'Enable'
    logger.info({ agentName, session, matchedAt, action, provider: providerType }, 'channel-mcp-reconnect: completed')
    return { ok: true, message: `Activated ${action} via /mcp (Up x${matchedAt})` }
  } catch (err) {
    logger.warn({ err, agentName, session }, 'channel-mcp-reconnect failed')
    try { execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 }) } catch { /* best effort */ }
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
