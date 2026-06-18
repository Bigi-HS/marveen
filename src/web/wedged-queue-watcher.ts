// Frozen-TUI / undelivered-queue watchdog for the main channels session.
//
// Incident 2026-06-14 (card 680e7441): marveen's TUI froze on an injected
// heartbeat prompt. The claude process AND the bun channel poller were both
// alive, but the TUI was wedged -- the pane showed the parked prompt with NO
// live input box and NO spinner (detectPaneState => 'unknown'), and it did not
// process keystrokes. Six inter-agent messages piled up to 100+ min before the
// operator noticed by hand.
//
// Why every existing main-session detector missed it:
//   - keepalive-staleness (channel-monitor): short-circuits the moment the bun
//     poller is alive ("stale keepalive + live poller = quiet conversation"),
//     so a frozen-TUI-but-poller-alive session is read as healthy.
//   - stall-detector (checkMainSessionStall): keys off TRANSCRIPT ingestion
//     (last `<channel source=` block) vs last assistant turn. A frozen TUI
//     never ingests the injected prompt into the transcript, so there is
//     nothing newer than the last assistant turn to compare -- no stall seen.
//   - down-handler: only fires when the channel plugin is DOWN. The plugin was
//     up. And the independent systemd-timer net (channel-watchdog.sh) does not
//     run here because `systemd --user` is offline on this host.
//
// The signal this watcher adds is the ROUTER's ground truth, immune to TUI-
// render ambiguity: the message-router has an inter-agent message it physically
// could not deliver to the main agent for longer than QUEUE_STALE_MS. Combined
// with a pane that is NOT promptable and NOT busy, that is a frozen agent --
// not a legitimately-busy recipient (card 7557a98d: a busy recipient defers,
// it is never a drop). Recovery is the same proven hard-restart the operator
// ran by hand and the stuck-tool-call watcher uses (channels.sh path, picks up
// the plugin-unlock + identity nets); the queued messages survive in SQLite and
// the router re-delivers them to the fresh session.
//
// Scope: MAIN channels session only. Sub-agents are driven by Marveen inter-
// agent and have their own per-agent watchdogs.

import { logger } from '../logger.js'
import { capturePane } from './agent-process.js'
import { MAIN_AGENT_ID } from '../config.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { hardRestartMarveenChannels, lastMainRespawnAt, MARVEEN_POST_RESPAWN_GRACE_MS } from './channel-monitor.js'
import { detectPaneState, type PaneState } from '../pane-state.js'
import { checkPaneDetectorGate } from './pane-detector-gate.js'
import { getPendingMessages } from '../db.js'

// The oldest undelivered inter-agent message must exceed this age before the
// queue counts as "stuck". 10 min matches the main-session STALL_THRESHOLD_MS:
// the router delivers to a promptable session within a tick or two, so a
// message still pending after 10 min while the pane is not promptable is a
// wedge, not a quiet moment. Exported for the test to track production.
export const QUEUE_STALE_MS = 10 * 60 * 1000

// Minimum gap between recoveries this watcher fires. If a respawn does not
// drain the queue (e.g. a token / rate-limit driven freeze a respawn cannot
// fix), do not hammer -- back off and let the down-cascade / operator take it.
// Mirrors STALL_RECOVERY_BACKOFF_MS.
export const WEDGE_RECOVERY_BACKOFF_MS = 30 * 60 * 1000

// Poll cadence. Offset (50s initial) so this pane-reader does not hit
// capture-pane on the same tick as channel-monitor (30s), stuck-tool-call
// (35s), stuck-input (15s/20s) or channel-health (45s).
const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 60_000
// Gap between the two pane samples. A frozen TUI reads not-promptable on both;
// a mid-render frame resolves to a promptable state on at least one, so a
// transient never trips the recovery.
const DOUBLE_SAMPLE_GAP_MS = 2_000

/**
 * True when a pane state is a recoverable frozen-TUI wedge.
 *
 * Recoverable: 'unknown' (no live input box, no spinner -- the frozen-TUI
 * shape) or null (capture failed -- fail toward recoverable; the stale-queue
 * requirement and the double-sample keep this from firing on a healthy pane).
 *
 * NOT recoverable:
 *   - 'busy' / 'typing': the agent is working or composing; an undelivered
 *     queue here is a legitimate defer (card 7557a98d), never a drop/respawn.
 *   - 'idle': the pane is promptable, so a stuck queue points at the router,
 *     not a frozen agent -- a respawn would be the wrong, context-losing fix.
 *   - 'error': the thinking-block API-error path is deliberately ALERT-ONLY
 *     (auto-reset would nuke working memory); leave it to that handler.
 */
export function isFrozenTuiWedge(state: PaneState | null): boolean {
  return state === 'unknown' || state == null
}

/**
 * Pure decision: should the main channels session be hard-restarted because an
 * inter-agent message has been undeliverable for too long while the pane is in
 * a non-promptable wedge state?
 *
 * Guards (each defers on its own):
 *   - empty queue -> nothing undelivered -> no evidence -> false
 *   - oldest pending younger than queueStaleMs -> not yet stuck -> false
 *   - pane is promptable / busy / typing / error -> not a frozen wedge -> false
 *   - inside the post-respawn cold-start grace -> a booting session is
 *     'unknown' while it loads -> false
 *   - inside the recovery backoff -> a respawn that did not help is not
 *     hammered -> false
 *
 * Pure + exported so the incident timeline and every false-positive guard are
 * unit-tested without touching tmux, the DB or the transcript.
 */
export function shouldRecoverWedgedQueue(opts: {
  oldestPendingAgeMs: number | null
  paneNotPromptable: boolean
  queueStaleMs: number
  msSinceLastMainRespawn: number | null
  respawnGraceMs: number
  msSinceLastRecovery: number | null
  recoveryBackoffMs: number
}): boolean {
  if (opts.oldestPendingAgeMs == null) return false
  if (opts.oldestPendingAgeMs <= opts.queueStaleMs) return false
  if (!opts.paneNotPromptable) return false
  if (opts.msSinceLastMainRespawn != null && opts.msSinceLastMainRespawn < opts.respawnGraceMs) return false
  if (opts.msSinceLastRecovery != null && opts.msSinceLastRecovery < opts.recoveryBackoffMs) return false
  return true
}

// Age (ms) of the oldest pending inter-agent message addressed to the main
// agent, or null when the queue is empty. getPendingMessages returns rows
// ascending by created_at (epoch SECONDS), so [0] is the oldest.
function oldestPendingAgeMs(nowMs: number): number | null {
  const pending = getPendingMessages(MAIN_AGENT_ID)
  if (pending.length === 0) return null
  const oldestCreatedAtSec = pending[0]!.created_at
  return nowMs - oldestCreatedAtSec * 1000
}

let lastRecoverAt = 0

// Double-sample the pane: a frozen TUI is not-promptable on BOTH samples; a
// mid-render frame resolves to a promptable state on at least one. Returns true
// only when both samples agree the pane is a frozen-TUI wedge.
function samplePaneNotPromptable(session: string): Promise<boolean> {
  const first = isFrozenTuiWedge(paneStateOf(session))
  if (!first) return Promise.resolve(false)
  return new Promise((resolve) => {
    setTimeout(() => resolve(isFrozenTuiWedge(paneStateOf(session))), DOUBLE_SAMPLE_GAP_MS)
  })
}

function paneStateOf(session: string): PaneState | null {
  const pane = capturePane(session)
  return pane == null ? null : detectPaneState(pane)
}

async function checkSession(session: string): Promise<void> {
  const now = Date.now()
  // Cheap pre-checks first, before any capture-pane I/O.
  const ageMs = oldestPendingAgeMs(now)
  if (ageMs == null || ageMs <= QUEUE_STALE_MS) return
  const lastRespawn = lastMainRespawnAt()
  if (lastRespawn > 0 && now - lastRespawn < MARVEEN_POST_RESPAWN_GRACE_MS) return
  if (lastRecoverAt > 0 && now - lastRecoverAt < WEDGE_RECOVERY_BACKOFF_MS) return

  // Suspicious: a genuinely stale queue outside any grace. Confirm the pane is a
  // frozen-TUI wedge via a double-sample before acting.
  const paneNotPromptable = await samplePaneNotPromptable(session)

  const decision = shouldRecoverWedgedQueue({
    oldestPendingAgeMs: oldestPendingAgeMs(Date.now()), // re-read: the queue may have drained during the sample gap
    paneNotPromptable,
    queueStaleMs: QUEUE_STALE_MS,
    msSinceLastMainRespawn: lastMainRespawnAt() ? Date.now() - lastMainRespawnAt() : null,
    respawnGraceMs: MARVEEN_POST_RESPAWN_GRACE_MS,
    msSinceLastRecovery: lastRecoverAt ? Date.now() - lastRecoverAt : null,
    recoveryBackoffMs: WEDGE_RECOVERY_BACKOFF_MS,
  })
  if (!decision) return

  const ageMin = Math.round(ageMs / 60000)
  logger.warn(
    { session, oldestPendingMin: ageMin, queueStaleMs: QUEUE_STALE_MS },
    'wedged-queue-watcher: inter-agent message undeliverable past threshold + pane not promptable -- frozen-TUI wedge, hard-restarting main channels session',
  )
  lastRecoverAt = Date.now()
  const result = hardRestartMarveenChannels()
  if (!result.ok) {
    logger.error({ session, error: result.error }, 'wedged-queue-watcher: hard restart failed')
  }
}

export function startWedgedQueueWatcher(): NodeJS.Timeout {
  function sweep() {
    // Stand down on a Claude CLI drift until a pane-detector smoke re-validates
    // it (card 56ad0fa3): a wedge verdict rests on detectPaneState=>'unknown',
    // which an unverified CLI render could produce for a healthy pane.
    if (!checkPaneDetectorGate('wedged-queue')) return
    checkSession(MAIN_CHANNELS_SESSION).catch((err) => {
      logger.debug({ err }, 'wedged-queue-watcher: main session check error')
    })
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
