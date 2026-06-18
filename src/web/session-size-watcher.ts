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
import { isReadyForPrompt, isActivelyWorking } from '../pane-state.js'
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

// BUSY tier (card 1f0d92a7). The soft + hard tiers above are BOTH idle-only: a
// session that is actively WORKING and never reaches an idle boundary can climb
// past the 80% wall (the context-window-watchdog alert line) unchecked -- only
// escalated to the operator, never auto-compacted. This tier closes that gap: an
// actively-working agent over BUSY_COMPACT_FRACTION gets a /compact QUEUED into
// its live turn, which Claude Code defers to the next turn boundary (it never
// interrupts the in-flight tool call -- docs-confirmed). The queued compact runs
// before the agent can keep climbing across subsequent turns.
//
// The fraction sits strictly between the soft (0.75) and the 80% alert wall so
// the busy compaction fires BEFORE the wall, and the idle tiers (cheaper,
// immediate) still get first crack at an agent that happens to reach idle. The
// gate is isActivelyWorking (a live spinner) -- NOT the coarse 'busy' state --
// so a usage-limit menu or pending-paste pane (both 'busy') is never injected
// into. Scope stays sub-agents only (Boss 2026-06-17): the main marveen session
// remains the channel-monitor's exclusive charge, never a second compact actor.
export const BUSY_COMPACT_FRACTION = 0.78

// Resolve the per-agent busy-compaction ceiling = contextWindow(model) * 0.78.
// Pure given the model id; its ordering (soft < busy < hard, and busy < 0.80) is
// asserted directly in the tests.
export function adaptiveBusyCeilingForModel(modelId: string | null | undefined): number {
  return Math.floor(contextWindowForModel(modelId) * BUSY_COMPACT_FRACTION)
}

// A queued /compact takes a turn boundary to actually fire. Without a cooldown
// the 2-min fast lane would queue a fresh /compact every sweep until it fires,
// piling redundant compactions behind the first. This cooldown (shared with the
// soft/hard tiers via lastCompactedAt) prevents the double-queue; once the
// compact fires the context drops below the ceiling and the loop self-clears.
export const BUSY_COMPACT_COOLDOWN_MS =
  Number(process.env.SESSION_BUSY_COMPACT_COOLDOWN_MS) || 45 * 60 * 1000 // 45 min default

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

/**
 * Pure BUSY-tier decision: should we QUEUE a /compact into an actively-working
 * session now?
 *
 * Returns true only when ALL hold:
 *   - context is known and at/over the busy ceiling (window * 0.78),
 *   - the pane is ACTIVELY working (a live turn spinner) -- the caller passes
 *     isActivelyWorking(pane); this is the safety gate that keeps the queued
 *     /compact off any idle / typing / unknown / usage-limit surface, and
 *   - the cooldown since the last compaction has elapsed (so we never stack a
 *     second queued /compact behind one that has not yet fired).
 *
 * The pane signal is a plain boolean so this stays pure and the surface gate is
 * asserted in isolation (mirroring shouldCompactSession / shouldHardCompact).
 */
export function shouldBusyCompact(
  contextTokens: number | null,
  busyCeiling: number,
  paneActivelyWorking: boolean,
  lastCompactedAt: number | null,
  now: number,
  cooldownMs: number,
): boolean {
  if (contextTokens == null || contextTokens < busyCeiling) return false
  if (!paneActivelyWorking) return false
  if (lastCompactedAt != null && now - lastCompactedAt < cooldownMs) return false
  return true
}

// IDLE-LOW tier (card fe8d4a8d / F1). The soft tier fires at window * 0.75, which
// for a 1M-window Opus is ~750K -- so a parked or heartbeat-driven Opus agent can
// sit at 200-600K of STALE context, re-paying cache_read on the whole tail every
// turn and every heartbeat fire for ~zero working benefit (the THREAD F finding:
// cache_read is ~70% of burn). This tier sheds that tail by compacting a
// SUSTAINED-IDLE agent at a LOW ABSOLUTE threshold, far below the model fraction.
//
// The danger of a blanket low threshold is compacting an agent that is mid-task
// and merely idle BETWEEN two turns (losing load-bearing working context -> more
// burn, the opposite of the goal). The guard is SUSTAINED idle: an actively-
// working agent goes busy every few minutes and so never accumulates the required
// continuous-idle window, while a parked/heartbeat agent is idle for long
// stretches. So this can only ever fire on the parked-with-stale-tail case.
export const IDLE_LOW_THRESHOLD_TOKENS =
  Number(process.env.SESSION_IDLE_LOW_THRESHOLD_TOKENS) || 200_000
// How long an agent must have been continuously NOT actively working before the
// idle-low tier may compact it. Long enough that a working agent's between-turn
// idle never qualifies; short enough to trim a parked agent promptly.
export const IDLE_LOW_SUSTAINED_MS =
  Number(process.env.SESSION_IDLE_LOW_SUSTAINED_MS) || 20 * 60 * 1000 // 20 min

/**
 * Pure IDLE-LOW decision: should we compact a sustained-idle agent that is
 * carrying a stale context tail? True only when ALL hold:
 *   - context is known and at/over the LOW absolute threshold (not the model
 *     fraction) -- the point is to trim well below the soft tier,
 *   - the agent has been continuously NOT actively working for at least
 *     requiredSustainedMs (the guard that excludes a mid-task agent merely idle
 *     between turns), and
 *   - the shared cooldown since the last compaction has elapsed.
 * The pane/idle-ready surface gate stays with the caller (as the other tiers),
 * so "only send to a ready idle pane" is asserted separately.
 */
export function shouldIdleLowCompact(
  contextTokens: number | null,
  idleLowThreshold: number,
  sustainedIdleMs: number,
  requiredSustainedMs: number,
  lastCompactedAt: number | null,
  now: number,
  cooldownMs: number,
): boolean {
  if (contextTokens == null || contextTokens < idleLowThreshold) return false
  if (sustainedIdleMs < requiredSustainedMs) return false
  if (lastCompactedAt != null && now - lastCompactedAt < cooldownMs) return false
  return true
}

/**
 * Stale-context cost proxy (card fe8d4a8d, the measurement lever): the cache_read
 * waste an idle agent is paying, as token-minutes = contextTokens * minutes of
 * continuous idle. The watcher has no per-turn count, so sustained-idle duration
 * is the available proxy for "how long this tail has been re-read for nothing".
 * Logged when the idle-low tier evaluates an over-threshold agent so the trim's
 * value is observable. Pure; returns 0 for unknown context.
 */
export function staleContextCostTokenMinutes(contextTokens: number | null, sustainedIdleMs: number): number {
  if (contextTokens == null || contextTokens <= 0 || sustainedIdleMs <= 0) return 0
  return Math.round(contextTokens * (sustainedIdleMs / 60000))
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
  // Is the pane ACTIVELY working (a live turn spinner)? When actively working
  // the BUSY tier queues a /compact that runs at the next turn boundary, so the
  // session is recoverable -- NOT terminal. Only a pane that is neither idle nor
  // actively working (a wedged dialog / unknown surface) is unrecoverable.
  paneActivelyWorking: boolean
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
 *   - over ceiling but actively working -> false (recoverable -- the BUSY tier
 *       queues a /compact that runs at the next turn boundary)
 *   - over ceiling, not idle, but still inside the stuck window -> false (transient)
 *   - over ceiling, neither idle nor working, past the window -> TRUE (terminal)
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
  // An actively-working pane is recoverable: the BUSY tier queues a /compact
  // that runs at the next turn boundary, so it is not the operator's problem.
  if (input.paneActivelyWorking) return false
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

// Per-agent wall-clock of when the agent was FIRST observed not actively working
// in the current idle spell (card fe8d4a8d). Set when a sweep sees a non-working
// pane and there is no open spell; cleared the moment the agent is actively
// working (and on stop). now - this = the continuous-idle duration the idle-low
// tier gates on, so an agent that goes busy between turns never accumulates it.
const notWorkingSince = new Map<string, number>()

function checkAgent(name: string): void {
  const contextTokens = latestContextTokens(name)
  const last = lastCompactedAt.get(name) ?? null
  const now = Date.now()
  const session = agentSessionName(name)
  const pane = capturePane(session)

  // Sustained-idle tracking (card fe8d4a8d): reset the idle clock whenever the
  // agent is actively working, so only a genuinely parked/heartbeat agent ever
  // accumulates the continuous-idle window the idle-low tier requires.
  const working = pane != null && isActivelyWorking(pane)
  if (working) notWorkingSince.delete(name)
  else if (!notWorkingSince.has(name)) notWorkingSince.set(name, now)
  const sustainedIdleMs = working ? 0 : now - (notWorkingSince.get(name) ?? now)

  // IDLE-LOW tier: trim a sustained-idle agent's stale context tail at a LOW
  // absolute threshold, below the model fraction. Idle-ready pane required (the
  // same never-mid-turn safety as the soft tier); the sustained-idle guard above
  // is what keeps a mid-task agent (idle only between turns) out of this path.
  if (
    shouldIdleLowCompact(contextTokens, IDLE_LOW_THRESHOLD_TOKENS, sustainedIdleMs, IDLE_LOW_SUSTAINED_MS, last, now, DEFAULT_COOLDOWN_MS) &&
    pane != null && isReadyForPrompt(pane) &&
    !shouldHoldProactiveWork(`compact-idle-low:${name}`)
  ) {
    logger.info(
      {
        agent: name,
        contextTokens,
        sustainedIdleMin: Math.round(sustainedIdleMs / 60000),
        staleCostTokenMin: staleContextCostTokenMinutes(contextTokens, sustainedIdleMs),
      },
      'session-size-watcher: sustained-idle agent over low threshold, sending /compact (stale-tail trim)',
    )
    try {
      sendPromptToSession(session, '/compact')
      lastCompactedAt.set(name, now)
    } catch (err) {
      logger.warn({ err, agent: name }, 'session-size-watcher: failed to send /compact (idle-low)')
    }
    return
  }

  // Model-adaptive threshold: contextWindow(model) * fraction, so a 200K-window
  // Sonnet/Haiku agent compacts ~150K and a 1M Opus agent ~750K. Cooldown stays
  // global. The idle-only gate below is unchanged.
  const thresholds: SessionSizeThresholds = {
    tokenThreshold: adaptiveTokenThresholdForModel(resolveAgentModelId(name)),
    cooldownMs: DEFAULT_COOLDOWN_MS,
  }
  if (!shouldCompactSession(contextTokens, last, now, thresholds)) return

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
    // The IMMEDIATE hard /compact still gates on idle: we never send it to a
    // non-idle pane. The BUSY tier (checkAgentBusyCompact) handles an
    // actively-working over-ceiling pane via a queued /compact, so here we only
    // need the escalation decision -- and an actively-working pane is recoverable
    // (the queued compact will fire), hence NOT terminal.
    const since = overCeilingSince.get(name) ?? now
    const overCeilingMs = now - since
    const working = pane != null && isActivelyWorking(pane)
    // Terminal-state decision (card b83e7c92 item-4): over ceiling + neither idle
    // NOR actively working (a wedged dialog/unknown surface) + stuck past the
    // window. Only then can neither the idle nor the busy /compact fire and a
    // nudge won't shrink the window -- the operator's call, not the watchdog's.
    const exhausted = decideContextExhausted(
      { contextTokens, hardCeiling, paneIsIdle: false, paneActivelyWorking: working, overCeilingMs },
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

// BUSY-tier check (fast lane, card 1f0d92a7). The two idle-gated tiers above
// cannot help an agent that is over the 80% wall and never reaches idle. This
// closes that gap: when an actively-WORKING agent crosses the busy ceiling
// (window * 0.78, below the 80% alert wall), QUEUE a /compact into its live
// turn. Claude Code defers queued input to the next turn boundary -- it never
// interrupts the in-flight tool call -- so the compact runs cleanly after the
// current turn, before the agent keeps climbing across subsequent turns.
//
// Safety: the gate is isActivelyWorking (a live spinner), a strict subset of
// 'busy' that EXCLUDES the usage-limit menu and pending-paste surfaces, so the
// queued Enter can never land on a blocking dialog (#130 false-ready class). A
// cooldown (shared via lastCompactedAt) prevents stacking a second queued
// /compact behind one that has not yet fired.
function checkAgentBusyCompact(name: string): void {
  const contextTokens = latestContextTokens(name)
  const busyCeiling = adaptiveBusyCeilingForModel(resolveAgentModelId(name))
  const last = lastCompactedAt.get(name) ?? null
  const now = Date.now()

  const session = agentSessionName(name)
  const pane = capturePane(session)
  const working = pane != null && isActivelyWorking(pane)
  if (!shouldBusyCompact(contextTokens, busyCeiling, working, last, now, BUSY_COMPACT_COOLDOWN_MS)) return

  // Fleet-pause gate (card fd30873b): a /compact is a model call; hold it under
  // an active token-budget pause exactly like the soft/hard tiers. Inert by
  // default (mode=off => false).
  if (shouldHoldProactiveWork(`compact-busy:${name}`)) return

  logger.info(
    { agent: name, contextTokens, busyCeiling },
    'session-size-watcher: context over BUSY ceiling while actively working, queuing /compact (turn-boundary)',
  )
  try {
    sendPromptToSession(session, '/compact')
    // Share the cooldown map so the soft/hard tiers respect this compaction and
    // we do not stack a second queued /compact before this one fires.
    lastCompactedAt.set(name, now)
  } catch (err) {
    logger.warn({ err, agent: name }, 'session-size-watcher: failed to queue /compact (busy ceiling)')
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
        // Reset the sustained-idle clock so a restart starts a fresh idle spell.
        notWorkingSince.delete(name)
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
        // BUSY tier first: an actively-working over-ceiling agent gets a queued
        // /compact (and the shared cooldown set) BEFORE the hard-ceiling check
        // runs, so the escalation correctly sees it as recoverable, not terminal.
        checkAgentBusyCompact(name)
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
