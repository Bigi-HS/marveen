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
import { listAgentNames, agentDir, readAgentClaudeConfigDir } from './agent-config.js'
import { agentSessionName, isAgentRunning, capturePane, sendPromptToSession } from './agent-process.js'
import { readContextTokensFromProjectDir } from './active-model.js'
import { isReadyForPrompt } from '../pane-state.js'

// Transcript size at which we compact. Empirically: Dave's 113k-token session
// produced a 1.5MB JSONL. 1MB is comfortably past normal work but well before
// the resume-menu risk zone. Adjust via THRESHOLDS if needed.
// Legacy byte proxy, kept for latestTranscriptSizeBytes + the future hard-ceiling
// tier (card: non-idle session checkpoint). No longer the compaction trigger.
export const DEFAULT_SIZE_THRESHOLD_BYTES = 1 * 1024 * 1024 // 1MB
// Phase 3 (token-aware): the live context size in TOKENS is the real per-turn
// cache_read driver. The byte proxy under-/over-fired vs the actual cost (a
// 950K-token session is what each turn re-reads, not the transcript bytes). 250K
// is comfortably past normal work yet well before the limit / resume-menu zone.
export const DEFAULT_TOKEN_THRESHOLD = 250_000
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
export const DEFAULT_HARD_CEILING_TOKENS = 650_000
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

const THRESHOLDS: SessionSizeThresholds = {
  tokenThreshold: DEFAULT_TOKEN_THRESHOLD,
  cooldownMs: DEFAULT_COOLDOWN_MS,
}

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

function checkAgent(name: string): void {
  const contextTokens = latestContextTokens(name)
  const last = lastCompactedAt.get(name) ?? null
  const now = Date.now()

  if (!shouldCompactSession(contextTokens, last, now, THRESHOLDS)) return

  const session = agentSessionName(name)
  const pane = capturePane(session)
  if (pane == null || !isReadyForPrompt(pane)) {
    logger.debug({ agent: name, contextTokens }, 'session-size-watcher: context large but pane not idle, deferring')
    return
  }

  logger.info(
    { agent: name, contextTokens },
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
  if (!shouldHardCompact(contextTokens, DEFAULT_HARD_CEILING_TOKENS)) {
    overCeilingSince.delete(name)
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
    if (now - since > HARD_CEILING_STUCK_WARN_MS) {
      logger.warn(
        { agent: name, contextTokens, stuckMs: now - since },
        'session-size-watcher: over HARD ceiling but never caught idle -- may need turn-boundary compaction',
      )
    } else {
      logger.debug(
        { agent: name, contextTokens },
        'session-size-watcher: over hard ceiling but pane not idle, deferring to next idle',
      )
    }
    return
  }

  logger.info(
    { agent: name, contextTokens, hardCeiling: DEFAULT_HARD_CEILING_TOKENS },
    'session-size-watcher: context over HARD ceiling while idle, sending /compact (cooldown bypassed)',
  )
  try {
    sendPromptToSession(session, '/compact')
    // Update the shared cooldown map so the soft tier respects this compaction.
    lastCompactedAt.set(name, now)
    overCeilingSince.delete(name)
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
