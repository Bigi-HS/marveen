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
import { listAgentNames, agentDir } from './agent-config.js'
import { agentSessionName, isAgentRunning, capturePane, sendPromptToSession } from './agent-process.js'
import { isReadyForPrompt } from '../pane-state.js'

// Transcript size at which we compact. Empirically: Dave's 113k-token session
// produced a 1.5MB JSONL. 1MB is comfortably past normal work but well before
// the resume-menu risk zone. Adjust via THRESHOLDS if needed.
export const DEFAULT_SIZE_THRESHOLD_BYTES = 1 * 1024 * 1024 // 1MB
// Do not compact the same session more often than this, so /compact does not
// interrupt a freshly-compacted agent that immediately starts heavy work again.
export const DEFAULT_COOLDOWN_MS = 3 * 60 * 60 * 1000 // 3 hours

export interface SessionSizeThresholds {
  sizeThresholdBytes: number
  cooldownMs: number
}

/**
 * Pure decision: should we send /compact to this session now?
 *
 * Returns true only when:
 *   - The transcript is large enough (>= sizeThresholdBytes)
 *   - The cooldown since the last compaction has elapsed
 *
 * Pane-state (idle/busy) is checked by the caller so it stays out of the
 * pure function and can be asserted separately.
 */
export function shouldCompactSession(
  transcriptSizeBytes: number | null,
  lastCompactedAt: number | null,
  now: number,
  thresholds: SessionSizeThresholds,
): boolean {
  if (transcriptSizeBytes == null || transcriptSizeBytes < thresholds.sizeThresholdBytes) return false
  if (lastCompactedAt != null && now - lastCompactedAt < thresholds.cooldownMs) return false
  return true
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

const THRESHOLDS: SessionSizeThresholds = {
  sizeThresholdBytes: DEFAULT_SIZE_THRESHOLD_BYTES,
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

function checkAgent(name: string): void {
  const sizeBytes = latestTranscriptSizeBytes(name)
  const last = lastCompactedAt.get(name) ?? null
  const now = Date.now()

  if (!shouldCompactSession(sizeBytes, last, now, THRESHOLDS)) return

  const session = agentSessionName(name)
  const pane = capturePane(session)
  if (pane == null || !isReadyForPrompt(pane)) {
    logger.debug({ agent: name, sizeBytes }, 'session-size-watcher: transcript large but pane not idle, deferring')
    return
  }

  logger.info(
    { agent: name, transcriptSizeMb: ((sizeBytes ?? 0) / 1024 / 1024).toFixed(2) },
    'session-size-watcher: transcript exceeds threshold while agent is idle, sending /compact',
  )
  try {
    sendPromptToSession(session, '/compact')
    lastCompactedAt.set(name, now)
  } catch (err) {
    logger.warn({ err, agent: name }, 'session-size-watcher: failed to send /compact')
  }
}

export function startSessionSizeWatcher(): NodeJS.Timeout {
  function sweep() {
    for (const name of listAgentNames()) {
      if (!isAgentRunning(name)) {
        // Clear the cooldown so a freshly restarted agent is not penalised for
        // a compaction that happened in the prior session.
        lastCompactedAt.delete(name)
        continue
      }
      try {
        checkAgent(name)
      } catch (err) {
        logger.debug({ err, agent: name }, 'session-size-watcher: agent check error')
      }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
