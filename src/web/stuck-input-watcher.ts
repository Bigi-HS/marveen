import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames } from './agent-config.js'
import { isAgentRunning, capturePane, sendEnterToSession } from './agent-process.js'
import { resolveAgentSession } from './channel-mcp-reconnect.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { checkPaneDetectorGate } from './pane-detector-gate.js'
import { checkIdlePipeRecovery, clearIdlePipeRecoveryAgent } from './idle-pipe-recovery.js'
import {
  stuckInputSignature,
  pendingPasteSignature,
  decideStuckInputRecovery,
  type StuckInputState,
  type StuckInputThresholds,
} from '../pane-state.js'

// Backstop recovery for a swallowed Enter on the channel-notification
// path. Inbound Telegram/Slack messages are delivered into the session by
// the channel plugin, NOT by sendPromptToSession, so the post-send
// Enter-retry budget there cannot cover them. After a long thinking turn
// the closing Enter is occasionally dropped and the user's message is
// left parked in the prompt box with no submit. This watcher captures
// each running agent's pane on a timer, and when the SAME text has been
// parked past the confirm window it re-sends Enter to submit it.
//
// All the decision logic is the pure decideStuckInputRecovery() in
// pane-state.ts (unit-tested); this module is only the I/O + per-session
// state map, mirroring channel-health-monitor.ts.

const THRESHOLDS: StuckInputThresholds = {
  // The same text must stay parked this long before the first recovery
  // Enter. A real turn transitions typing -> busy within a second or two
  // of submit, so 10s comfortably clears the frame race while still
  // recovering a genuinely swallowed Enter quickly.
  confirmMs: 10_000,
  // Gap between recovery Enters within one spell.
  dedupMs: 12_000,
  // A pane still parked after this many Enters is not the swallowed-Enter
  // case this path targets; stop and log. (A stale paste placeholder, which
  // detectPaneState classifies as busy so it never reaches this 'typing'
  // path, has its own recovery below via pendingPasteSignature.)
  maxAttempts: 3,
}

// Stale pending-paste recovery (card 1b0f58ba). A `[Pasted text #N]`
// placeholder reads as 'busy', so the typing path above never sees it; when
// the closing Enter is swallowed on the channel-notification path the paste
// sits parked indefinitely. This sibling spell tracks the placeholder via
// pendingPasteSignature and re-submits it through the SAME pure decision
// machinery, with a minutes-long confirm window so a turn that is genuinely
// processing the paste (or a burst still arriving) is never pre-empted.
const PASTE_THRESHOLDS: StuckInputThresholds = {
  // The placeholder must sit unchanged this long before the first recovery
  // Enter. Minutes, not the typing path's 10s: a real paste turn submits and
  // transitions to a spinner quickly, so a placeholder this stale with no
  // spinner is a swallowed Enter, not work in flight. (card range 120-180s.)
  confirmMs: 150_000,
  // Gap between recovery Enters within one spell.
  dedupMs: 30_000,
  // A single Enter submits the parked paste; allow one retry, then give up.
  maxAttempts: 2,
}

// Initial delay before the first sweep, and the sweep interval. Offset
// from channel-monitor (30s) and channel-health-monitor (45s) so the
// three watchers do not pile their capture-pane calls onto one tick.
const INITIAL_DELAY_MS = 20_000
const INTERVAL_MS = 15_000

const NO_STATE: StuckInputState = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }

const watchState = new Map<string, StuckInputState>()
const pasteWatchState = new Map<string, StuckInputState>()

// Run one signature/decision spell for a session against its own state map,
// sending a recovery Enter and logging the give-up exactly once per spell.
// Shared by the typing path and the stale-paste path -- same pure machinery,
// independent bookkeeping and thresholds.
function runRecoverySpell(
  label: string,
  session: string,
  sig: string | null,
  store: Map<string, StuckInputState>,
  thresholds: StuckInputThresholds,
  kind: 'parked input' | 'stale paste',
): void {
  const prev = store.get(session) ?? NO_STATE
  const { recover, next } = decideStuckInputRecovery(sig, prev, Date.now(), thresholds)

  if (next.parkedSig === null) {
    store.delete(session)
  } else {
    store.set(session, next)
  }

  if (recover) {
    logger.info(
      { label, session, attempt: next.attempts, kind },
      'stuck-input-watcher: parked input persisted past confirm window, sending recovery Enter',
    )
    sendEnterToSession(session)
  } else if (next.parkedSig !== null && next.attempts >= thresholds.maxAttempts) {
    // Logged at most once per spell: the give-up is recorded on the tick
    // that spent the last attempt (attempts hits maxAttempts there), not
    // every subsequent tick, because once at the cap recover stays false
    // and attempts no longer increments.
    if (prev.attempts < thresholds.maxAttempts) {
      logger.warn({ label, session, kind }, 'stuck-input-watcher: input still parked after max recovery Enters, giving up for this spell')
    }
  }
}

function checkSession(label: string, session: string): void {
  const pane = capturePane(session)
  // Piggy-back the busy->idle pipe-recovery edge on this same capture (card
  // 667281e4): zero extra tmux work, and it only acts when the pipe is actually
  // down at a turn-end. Runs after the CLI-drift gate (sweep guards it) since it
  // reads detectPaneState too.
  if (pane != null) checkIdlePipeRecovery(label, pane)
  // A failed capture is treated as "nothing parked" -- it ends any active
  // spell rather than holding stale state across a transient tmux miss. The
  // two signatures are mutually exclusive per tick (a paste placeholder reads
  // 'busy', plain parked text reads 'typing'), so at most one spell is ever
  // active for a session at a time.
  const typingSig = pane == null ? null : stuckInputSignature(pane)
  const pasteSig = pane == null ? null : pendingPasteSignature(pane)

  runRecoverySpell(label, session, typingSig, watchState, THRESHOLDS, 'parked input')
  runRecoverySpell(label, session, pasteSig, pasteWatchState, PASTE_THRESHOLDS, 'stale paste')
}

export function startStuckInputWatcher(): NodeJS.Timeout {
  function sweep() {
    // Stand down on a Claude CLI drift until a pane-detector smoke re-validates
    // it (card 56ad0fa3): the recovery decision reads detectPaneState, which
    // could mis-fire on an unverified CLI render and nudge a healthy agent.
    if (!checkPaneDetectorGate('stuck-input')) return
    // The main agent's channels session is named `<id>-channels`, not
    // `agent-<id>`, so isAgentRunning (which checks the agent- prefix)
    // does not apply. Check it directly; capturePane returns null when it
    // is not up, which ends any spell without acting.
    try {
      checkSession(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.debug({ err }, 'stuck-input-watcher: main agent check error')
    }
    for (const name of listAgentNames()) {
      if (!isAgentRunning(name)) {
        watchState.delete(resolveAgentSession(name))
        pasteWatchState.delete(resolveAgentSession(name))
        clearIdlePipeRecoveryAgent(name)
        continue
      }
      try {
        checkSession(name, resolveAgentSession(name))
      } catch (err) {
        logger.debug({ err, agent: name }, 'stuck-input-watcher: agent check error')
      }
    }
  }

  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
