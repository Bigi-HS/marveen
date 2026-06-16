// Proactive session compaction for sub-agents.
//
// When a running agent's transcript JSONL grows beyond the size threshold
// (~80-100k tokens), the agent becomes slow and expensive. More critically:
// on the NEXT restart with --continue, Claude Code will render the
// "Resume from summary" interactive menu in the detached tmux session where
// no human is watching, and the agent will freeze at the menu until killed.
//
// This watcher preempts that by sending /compact while the pane is idle,
// so the context is already compacted before any restart is needed and the
// resume-menu scenario never arises.
//
// Scope: sub-agents only. The main channels session (marveen) is managed by
// its own recovery cascade in channel-monitor.ts.
//
// Architecture mirrors stuck-tool-call-watcher.ts:
//   - Pure shouldCompactSession() decision (exported for unit tests)
//   - Per-session cooldown Map
//   - Periodic sweep with initial offset from other watchers

import { statSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'
import {
  listAgentNames,
  agentDir,
  readAgentClaudeConfigDir,
  readAgentModel,
  contextWindowForModel,
} from './agent-config.js'
import { agentSessionName, isAgentRunning, capturePane, sendPromptToSession } from './agent-process.js'
import { readContextTokensFromProjectDir, readActiveModelFromProjectDir } from './active-model.js'
import { isReadyForPrompt } from '../pane-state.js'
import { shouldHoldProactiveWork } from './fleet-pause-enforcer.js'
import { notifyChannel } from '../notify.js'

// Transcript size at which we compact. Empirically: Dave's 113k-token session
// produced a 1.5MB JSONL. 1MB is comfortably past normal work but well before
// the resume-menu risk zone.
// Legacy byte proxy, kept for latestTranscriptSizeBytes + the future hard-ceiling
// tier (card: non-idle session checkpoint). No longer the compaction trigger.
export const DEFAULT_SIZE_THRESHOLD_BYTES = 1 * 1024 * 1024 // 1MB
// Phase 3 (token-aware): the live context size in TOKENS is the real per-turn
// cache_read driver. The byte proxy under-/over-fired vs the actual cost (a
// 950K-token session is what each turn re-reads, not the transcript bytes).
//
// Phase 4 (model-adaptive): a single fixed threshold is wrong for every model
// but one. 250K only ever fired for 1M-context (opus-4-8[1m]) agents and was a
// dead no-op for Sonnet/Haiku (200K window -- they hit their hard limit before
// 250K). The threshold is now derived per-agent as contextWindow * the fraction
// below (Sonnet 200K -> 150K, opus-1M -> 750K), so every archetype gets a
// preemptive compact. DEFAULT_TOKEN_THRESHOLD is kept only as the fallback when
// the model's context window is unknown (DEFAULT_CONTEXT_WINDOW * fraction).
export const COMPACT_THRESHOLD_FRACTION = 0.75
export const DEFAULT_TOKEN_THRESHOLD = 250_000

// Resolve the per-agent token threshold = contextWindow(model) * fraction. Uses
// the agent's LIVE model from the transcript when available (it may differ from
// the configured model after a manual /model switch), falling back to the
// configured model id. Pure given the two model ids, so it is unit-testable via
// adaptiveTokenThresholdForModel below.
export function adaptiveTokenThresholdForModel(modelId: string | null | undefined): number {
  return Math.floor(contextWindowForModel(modelId) * COMPACT_THRESHOLD_FRACTION)
}

// The live model the agent is currently answering on, falling back to its
// configured model id (and ultimately the DEFAULT model inside readAgentModel).
function resolveAgentModelId(agentName: string): string {
  const live = readActiveModelFromProjectDir(
    agentDir(agentName),
    undefined,
    readAgentClaudeConfigDir(agentName) ?? undefined,
  )
  return live ?? readAgentModel(agentName)
}
// Do not compact the same session more often than this, so /compact does not
// interrupt a freshly-compacted agent that immediately starts heavy work again.
export const DEFAULT_COOLDOWN_MS = 3 * 60 * 60 * 1000 // 3 hours

// HARD-ceiling tier (card 8a734a43). The soft tier above is idle-ONLY + a 3h
// cooldown, so a long-running ACTIVE session (e.g. a marathon agent at 396K+
// that the 10-min sweep keeps catching mid-work) grows toward the 1M limit
// unchecked. The hard tier targets that: a much higher ceiling that, once
// crossed, BYPASSES the cooldown and is polled on a faster lane -- while keeping
// the same safety invariant as the soft tier (compact ONLY at a between-turn
// idle boundary, never mid-tool). It never sends to a busy pane; it just catches
// the next idle window sooner and ignores the cooldown.
//
// Model-adaptive (Phase 4, paired with the soft tier): the hard ceiling is
// derived per-agent as contextWindow(model) * HARD_CEILING_FRACTION, with the
// fraction kept strictly ABOVE the soft COMPACT_THRESHOLD_FRACTION so the two
// tiers never invert -- the soft (idle-only) trigger always sits below the hard
// (cooldown-bypassing) trigger for every model. A fixed 650K ceiling was wrong
// the same way the fixed soft threshold was: it never fired for a 200K-window
// Sonnet/Haiku agent (real limit far below 650K), and for a 1M Opus agent it sat
// BELOW the new 750K soft trigger, preempting it. Adaptive fixes both (Sonnet
// 200K -> hard 180K > soft 150K; Opus 1M -> hard 900K > soft 750K).
// DEFAULT_HARD_CEILING_TOKENS stays exported as the explicit value the pure
// shouldHardCompact() callers/tests pass; the live sweep uses the adaptive fn.
export const HARD_CEILING_FRACTION = 0.9
export const DEFAULT_HARD_CEILING_TOKENS = 650_000

// Resolve the per-agent hard ceiling = contextWindow(model) * HARD_CEILING_FRACTION.
// Pure given the model id, so it is unit-testable and its ordering vs
// adaptiveTokenThresholdForModel (soft < hard) is asserted directly.
export function adaptiveHardCeilingForModel(modelId: string | null | undefined): number {
  return Math.floor(contextWindowForModel(modelId) * HARD_CEILING_FRACTION)
}
// Fast lane: poll over-ceiling agents far more often than the 10-min soft sweep
// so a busy agent's brief between-turn idle is caught quickly.
const HARD_CEILING_INTERVAL_MS = 2 * 60 * 1000 // every 2 minutes
const HARD_CEILING_INITIAL_DELAY_MS = 90 * 1000 // offset from the soft sweep + other watchers
// Log-only warning when an agent stays over the hard ceiling but is NEVER caught
// idle for this long -- a candidate for the (deferred, riskier) turn-boundary
// injection approach. Configurable via env so we can tune it without a rebuild.
const HARD_CEILING_STUCK_WARN_MS =
  Number(process.env.SESSION_HARD_CEILING_STUCK_WARN_MS) || 30 * 60 * 1000 // 30 min default

export interface SessionSizeThresholds {
  tokenThreshold: number
  cooldownMs: number
}

/**
 * Pure decision: should we send /compact to this session now?
 *
 * Returns true only when:
 *   - The live context is large enough (>= tokenThreshold), measured in TOKENS
 *     (the actual cache_read cost re-read every turn), not transcript bytes.
 *   - The cooldown since the last compaction has elapsed.
 *
 * Pane-state (idle/busy) is checked by the caller so it stays out of the pure
 * function and can be asserted separately.
 */
export function shouldCompactSession(
  contextTokens: number | null,
  lastCompactedAt: number | null,
  now: number,
  thresholds: SessionSizeThresholds,
): boolean {
  if (contextTokens == null || contextTokens < thresholds.tokenThreshold) return false
  if (lastCompactedAt != null && now - lastCompactedAt < thresholds.cooldownMs) return false
  return true
}

/**
 * Pure HARD-ceiling decision: is the live context at/over the hard ceiling?
 *
 * Deliberately has NO cooldown term -- at 650K we must compact at the next safe
 * boundary even if we compacted recently. The idle/pane gate stays with the
 * caller, so the "compact only between turns, never mid-tool" invariant is
 * asserted separately (exactly as the soft tier does).
 */
export function shouldHardCompact(contextTokens: number | null, hardCeiling: number): boolean {
  if (contextTokens == null) return false
  return contextTokens >= hardCeiling
}

// Inputs to the context-exhausted terminal-state decision. Grouped so the pure
// function below has no hidden coupling to the watcher's maps/clock.
export interface ContextExhaustionInput {
  // Live context size in tokens; null when the transcript is unreadable.
  contextTokens: number | null
  // Per-agent hard ceiling = contextWindow(model) * HARD_CEILING_FRACTION.
  hardCeiling: number
  // Is the pane currently at a ready idle boundary? When idle, the hard-ceiling
  // /compact CAN fire and recover the session -- so it is NOT terminal.
  paneIsIdle: boolean
  // Continuous time (ms) the agent has been over the ceiling. 0 when not over.
  overCeilingMs: number
}

/**
 * Pure decision: is the agent in the context-exhausted / unrecoverable terminal
 * state (escalate to the operator, do NOT nudge)?
 *
 * The normal recovery is the idle-gated hard-ceiling /compact (checkAgentHard-
 * Ceiling). It can only run when the pane reaches an idle boundary. An agent
 * that is over the ceiling AND never reaches idle AND has stayed that way past
 * the stuck window is one the watchdog cannot help: /compact can't fire (no idle
 * boundary) and a nudge won't shrink the window. That is the terminal state.
 *
 * Guards (each its own adversarial fixture):
 *   - unknown tokens                 -> false (can't tell -- never escalate blind)
 *   - under the hard ceiling         -> false (not a context problem at all)
 *   - over ceiling but pane is idle  -> false (recoverable -- /compact will fire)
 *   - over ceiling, not idle, but still inside the stuck window -> false (transient)
 *   - over ceiling, not idle, past the stuck window -> TRUE (terminal -> escalate)
 *
 * Crucially this fires ONLY on the positive signal; when it is false every
 * existing path (auto-/compact, nudge, log-warn) is unchanged.
 */
export function decideContextExhausted(
  input: ContextExhaustionInput,
  stuckMs: number,
): boolean {
  if (input.contextTokens == null) return false
  if (input.contextTokens < input.hardCeiling) return false
  if (input.paneIsIdle) return false
  return input.overCeilingMs >= stuckMs
}

// How long between repeat operator escalations for the same stuck-exhausted
// agent, so a session wedged for hours alerts on a sane cadence rather than
// every 2-min hard sweep. Matches the channel-monitor 30-min alert dedup.
export const CONTEXT_EXHAUSTED_ALERT_DEDUP_MS = 30 * 60 * 1000

// Find the size of the most recently modified .jsonl transcript for the agent.
// Claude Code creates a new UUID.jsonl per session; the most recently touched
// file is the live session. Returns null when no transcript exists yet (freshly
// created agent with no prior sessions).
export function latestTranscriptSizeBytes(agentName: string): number | null {
  const dir = agentDir(agentName)
  const encodedProject = dir.replace(/\//g, '-')
  const projectDir = join(homedir(), '.claude', 'projects', encodedProject)
  if (!existsSync(projectDir)) return null
  try {
    const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))
    if (files.length === 0) return null
    let latestMtime = 0
    let latestSize = 0
    for (const f of files) {
      try {
        const st = statSync(join(projectDir, f))
        if (st.mtimeMs > latestMtime) {
          latestMtime = st.mtimeMs
          latestSize = st.size
        }
      } catch { /* skip unreadable */ }
    }
    return latestSize > 0 ? latestSize : null
  } catch {
    return null
  }
}

// Phase 3: the live session's context size in TOKENS (input + cache_read +
// cache_creation from the last usage), via the shared active-model reader. This
// is the actual per-turn cost /compact targets -- a far better signal than the
// transcript file bytes. Config-dir-aware (the agent's isolated CLAUDE_CONFIG_DIR).
export function latestContextTokens(agentName: string): number | null {
  return readContextTokensFromProjectDir(agentDir(agentName), readAgentClaudeConfigDir(agentName) ?? undefined)
}

// Only the cooldown is global; the token threshold is computed per-agent from
// the agent's model context window (see checkAgent), so it is not part of this
// shared default any more.

// Initial delay before the first sweep. Agents need time to boot and complete
// their startup modal dismiss before we probe them. Offset from other watchers:
// channel-monitor 30s, channel-health 45s, stuck-input 20s, stuck-tool-call 35s.
const INITIAL_DELAY_MS = 5 * 60 * 1000 // 5 minutes
const INTERVAL_MS = 10 * 60 * 1000 // every 10 minutes

// Per-agent wall-clock time of the last /compact we issued. Cleared when the
// agent stops so a restarted agent gets a fresh cooldown.
const lastCompactedAt = new Map<string, number>()

// Per-agent wall-clock of when we FIRST observed it over the hard ceiling while
// still busy (never caught idle). Used only to warn on a never-idle agent.
// Cleared on a successful hard compaction, on stop, or when it drops below the
// ceiling.
const overCeilingSince = new Map<string, number>()

// Per-agent wall-clock of the last context-exhausted operator escalation, so a
// session wedged for hours alerts on the dedup cadence rather than every sweep.
// Cleared when the agent recovers (drops below ceiling) or stops.
const lastExhaustedAlertAt = new Map<string, number>()

function checkAgent(name: string): void {
  const contextTokens = latestContextTokens(name)
  const last = lastCompactedAt.get(name) ?? null
  const now = Date.now()

  // Model-adaptive threshold: contextWindow(model) * fraction, so a 200K-window
  // Sonnet/Haiku agent compacts ~150K and a 1M Opus agent ~750K. Cooldown stays
  // global. The idle-only gate below is unchanged.
  const thresholds: SessionSizeThresholds = {
    tokenThreshold: adaptiveTokenThresholdForModel(resolveAgentModelId(name)),
    cooldownMs: DEFAULT_COOLDOWN_MS,
  }
  if (!shouldCompactSession(contextTokens, last, now, thresholds)) return

  const session = agentSessionName(name)
  const pane = capturePane(session)
  if (pane == null || !isReadyForPrompt(pane)) {
    logger.debug({ agent: name, contextTokens }, 'session-size-watcher: context large but pane not idle, deferring')
    return
  }

  // Fleet-pause gate (card fd30873b, DA HIGH-1): /compact is itself a model call.
  // Under a token-budget pause (today's only pause reason) it would burn the very
  // five-hour window we are trying to let reset, so hold it. The session is idle
  // and held, so its context is not growing; it compacts on the next sweep after
  // the pause self-clears. Inert by default (mode=off => false).
  if (shouldHoldProactiveWork(`compact-soft:${name}`)) return

  logger.info(
    { agent: name, contextTokens, tokenThreshold: thresholds.tokenThreshold },
    'session-size-watcher: context exceeds token threshold while agent is idle, sending /compact',
  )
  try {
    sendPromptToSession(session, '/compact')
    lastCompactedAt.set(name, now)
  } catch (err) {
    logger.warn({ err, agent: name }, 'session-size-watcher: failed to send /compact')
  }
}

// Hard-ceiling check (fast lane). An agent at/over the hard ceiling is compacted
// at its next idle boundary REGARDLESS of the soft cooldown. The idle gate is
// the same safety invariant as checkAgent: we NEVER send /compact to a busy /
// mid-tool pane -- we only catch the next between-turn idle, sooner.
function checkAgentHardCeiling(name: string): void {
  const contextTokens = latestContextTokens(name)
  // Per-model hard ceiling = contextWindow(model) * 0.9, mirroring the soft
  // tier's per-model derivation, so a 200K-window agent's ceiling is ~180K and a
  // 1M agent's is ~900K -- both strictly above their soft trigger, never inverted.
  const hardCeiling = adaptiveHardCeilingForModel(resolveAgentModelId(name))
  if (!shouldHardCompact(contextTokens, hardCeiling)) {
    overCeilingSince.delete(name)
    // Recovered below the ceiling -> re-arm the escalation so a future wedge
    // alerts again rather than staying suppressed by the stale dedup stamp.
    lastExhaustedAlertAt.delete(name)
    return
  }
  const now = Date.now()
  if (!overCeilingSince.has(name)) overCeilingSince.set(name, now)

  const session = agentSessionName(name)
  const pane = capturePane(session)
  if (pane == null || !isReadyForPrompt(pane)) {
    // Safety invariant: never compact a busy / mid-tool pane. Defer to the next
    // between-turn idle. Warn (log-only) if it has been stuck over-ceiling but
    // never idle for too long -- a candidate for the deferred turn-boundary
    // approach, but we take NO risky action here.
    const since = overCeilingSince.get(name) ?? now
    const overCeilingMs = now - since
    // Terminal-state decision (card b83e7c92 item-4): over ceiling + never idle +
    // stuck past the window. The idle-gated /compact cannot fire here and a nudge
    // won't shrink the window, so this is the operator's call, not the watchdog's.
    const exhausted = decideContextExhausted(
      { contextTokens, hardCeiling, paneIsIdle: false, overCeilingMs },
      HARD_CEILING_STUCK_WARN_MS,
    )
    if (exhausted) {
      logger.warn(
        { agent: name, contextTokens, stuckMs: overCeilingMs },
        'session-size-watcher: over HARD ceiling but never caught idle -- may need turn-boundary compaction',
      )
      // ESCALATE, do NOT nudge: surface the unrecoverable session to the operator
      // on the dedup cadence. Fire-and-forget; a failed notify must not wedge the
      // sweep. This is the ONLY new side effect, gated entirely on the positive
      // signal -- every other path is unchanged when `exhausted` is false.
      const lastAlert = lastExhaustedAlertAt.get(name)
      if (lastAlert == null || now - lastAlert >= CONTEXT_EXHAUSTED_ALERT_DEDUP_MS) {
        lastExhaustedAlertAt.set(name, now)
        const stuckMin = Math.round(overCeilingMs / 60000)
        notifyChannel(
          `🚨 A(z) ${name} agens context-kimerult allapotban ragadt: ${stuckMin} perce a hard-ceiling (${hardCeiling.toLocaleString()} token) felett, de SOHA nem ert idle hatart, igy az auto-/compact nem tud lefutni es a nudge sem segit. Kezi beavatkozas kell: tmux attach -t ${session} -> /compact vagy friss session. (Nem nudge-olom tovabb.)`,
        ).catch(() => {})
      }
    } else {
      logger.debug(
        { agent: name, contextTokens },
        'session-size-watcher: over hard ceiling but pane not idle, deferring to next idle',
      )
    }
    return
  }

  // Fleet-pause gate (card fd30873b, DA HIGH-1): hold the hard-ceiling /compact
  // too under an active pause -- the held session is idle and not growing, so it
  // is safe to defer to the next sweep after the pause self-clears, rather than
  // spend a model call on the exhausted window. Inert by default (mode=off).
  if (shouldHoldProactiveWork(`compact-hard:${name}`)) return

  logger.info(
    { agent: name, contextTokens, hardCeiling },
    'session-size-watcher: context over HARD ceiling while idle, sending /compact (cooldown bypassed)',
  )
  try {
    sendPromptToSession(session, '/compact')
    // Update the shared cooldown map so the soft tier respects this compaction.
    lastCompactedAt.set(name, now)
    overCeilingSince.delete(name)
    // Recovered via idle /compact -> re-arm escalation for any future wedge.
    lastExhaustedAlertAt.delete(name)
  } catch (err) {
    logger.warn({ err, agent: name }, 'session-size-watcher: failed to send /compact (hard ceiling)')
  }
}

export function startSessionSizeWatcher(): NodeJS.Timeout {
  function sweep() {
    for (const name of listAgentNames()) {
      if (!isAgentRunning(name)) {
        // Clear the cooldown so a freshly restarted agent is not penalised for
        // a compaction that happened in the prior session.
        lastCompactedAt.delete(name)
        overCeilingSince.delete(name)
        continue
      }
      try {
        checkAgent(name)
      } catch (err) {
        logger.debug({ err, agent: name }, 'session-size-watcher: agent check error')
      }
    }
  }

  // Hard-ceiling fast lane: a separate, more frequent sweep that only acts on
  // agents over the hard ceiling (cheap -- it just reads contextTokens and skips
  // everyone under the ceiling), so a busy over-ceiling agent is caught at its
  // next idle window within ~2 min instead of waiting up to 10.
  function hardSweep() {
    for (const name of listAgentNames()) {
      if (!isAgentRunning(name)) {
        overCeilingSince.delete(name)
        // A stopped agent re-arms: a restart starts a fresh window, so a prior
        // exhaustion alert must not suppress a genuine new one.
        lastExhaustedAlertAt.delete(name)
        continue
      }
      try {
        checkAgentHardCeiling(name)
      } catch (err) {
        logger.debug({ err, agent: name }, 'session-size-watcher: hard-ceiling check error')
      }
    }
  }

  setTimeout(sweep, INITIAL_DELAY_MS)
  setTimeout(hardSweep, HARD_CEILING_INITIAL_DELAY_MS)
  setInterval(hardSweep, HARD_CEILING_INTERVAL_MS)
  // The soft-sweep interval is returned for lifecycle parity with the original
  // single-timer API; the hard-sweep timer runs for the process lifetime.
  return setInterval(sweep, INTERVAL_MS)
}
