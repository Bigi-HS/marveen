// Token-outage auto-ACK bridge (P3, Boss #1: keep Genesis usable token-free).
//
// A DETERMINISTIC, zero-Claude always-on watcher. When the shared Claude account
// hits its usage limit the main orchestrator session freezes on the limit menu
// and silently stops processing inbound -- the token-reset-idle-gap. This bridge
// closes the full loop with NO Claude tokens:
//
//   DETECT-limit  -> ACK the operator on Telegram + capture the queued inbound to
//                    a kanban card so nothing is lost
//   DETECT-reset  -> "back online" message + RE-DISPATCH the queue (reuse the
//                    main-session --continue respawn so the orchestrator replays
//                    and reprocesses what it missed)
//
// All side effects are injected (capture-pane, Telegram send, kanban write,
// respawn, clock, state IO) so the transition logic is unit-tested without a
// live outage. The Telegram send is ONE-WAY (Bot API sendMessage via the main
// token) -- it never polls getUpdates, which would 409-conflict with the native
// plugin. Per-message acking is deliberately out of scope (Phase 2 / local qwen);
// Phase 1 is state-based: one ACK per outage window.

import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { resolveFromPath } from '../platform.js'
import { channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { capturePane } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { sendFallbackAlert } from './telegram-pipe-watchdog.js'
import { resumeMarveenSession } from './channel-monitor.js'
import { getPendingMessages, type AgentMessage } from '../db.js'
import { createCard } from '../noa-kanban.js'

const TMUX = resolveFromPath('tmux')

const PROVIDER: ChannelProviderType = 'telegram'
const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
const STATE_PATH = join(PROJECT_ROOT, 'store', 'token-outage-state.json')
// Shared with channel-monitor's cross-layer respawn coordination (epoch SECONDS).
const RESPAWN_STAMP_FILE = join(PROJECT_ROOT, 'store', '.channel-last-respawn')

const ALERT_CHAT_ID = process.env.WATCHDOG_ALERT_CHAT_ID ?? '8643929442'
// After a reset we want a PROMPT re-dispatch, but never within this window of a
// respawn anyone else (channel-monitor / channel-watchdog) just did.
const REDISPATCH_BACKOFF_MS = 5 * 60 * 1000

// Match for the Claude Code usage/session-limit UI. The first three were observed
// LIVE (2026-06-07, Dave+Thor freezes) and captured from the pane verbatim:
//   "You've hit your session limit · resets 7:40pm (Europe/Budapest)"
//   "Stop and wait for limit to reset"   (the menu option line)
// The rest are generic fallbacks for older/other limit UIs. Each requires a
// STRONG limit phrase so a conversation merely mentioning "usage limit" doesn't
// trip it. Matched against the last visible lines (where the menu renders), not
// full scrollback. NOTE: the menu header "What do you want to do?" and the
// "Upgrade your plan" option are deliberately NOT patterns -- too generic alone.
export const LIMIT_PATTERNS: RegExp[] = [
  /you've hit your (?:usage|session) limit/i,
  /(?:usage|session) limit reached/i,
  /stop and wait for limit to reset/i,
  /you've reached your usage limit/i,
  /approaching .*usage limit/i,
  /claude usage limit/i,
  /limit will reset/i,
  // "resets 7:40pm (...)" / "resets at 3pm" -- requires a time so it stays strong.
  /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)/i,
]
const PANE_TAIL_LINES = 18

export interface LimitDetection {
  limited: boolean
  resetAtText: string | null
}

export interface OutageState {
  limited: boolean
  enteredAtMs: number
  ackSent: boolean
  capturedCardId: string | null
  staleLimitKilled?: boolean
}

export interface CycleResult {
  state: OutageState
  transition: 'none' | 'entered' | 'exited' | 'stale-relaunch'
  acked: boolean
  captured: boolean
  redispatched: boolean
}

// How long a session can stay stuck on the limit modal before the bridge
// force-relaunches it. Set to 20 min so a normal short limit window (< 5 min
// observed in practice) is never disturbed, while a genuinely wedged session
// (the 14:06 incident: 55 min stuck, no EXITED) gets recovered automatically.
export const DEFAULT_STALE_OUTAGE_MS = 20 * 60 * 1000

export interface OutageDeps {
  detectLimit: () => LimitDetection
  sendTelegram: (text: string) => Promise<boolean>
  getQueue: () => AgentMessage[]
  createCard: (pending: AgentMessage[], resetAtText: string | null, now: number) => string | null
  msSinceLastRespawn: () => number
  redispatch: () => boolean
  // Dismiss the limit modal so the session self-heals on reset instead of
  // staying permanently wedged on the interactive menu. Default: send-keys "1".
  dismissModal: () => void
  // Hard-relaunch the session when it has been stuck in the modal for more than
  // staleOutageMs. Default: kill-session + channels.sh relaunch.
  relaunchSession: () => boolean
  staleOutageMs: number
  readState: () => OutageState
  writeState: (s: OutageState) => void
  redispatchBackoffMs: number
}

const EMPTY_STATE: OutageState = { limited: false, enteredAtMs: 0, ackSent: false, capturedCardId: null }

// ---- pure classification (unit-tested directly) ----

export function classifyPane(paneText: string | null, patterns: RegExp[] = LIMIT_PATTERNS): LimitDetection {
  if (!paneText) return { limited: false, resetAtText: null }
  const tail = paneText.split('\n').slice(-PANE_TAIL_LINES).join('\n')
  const limited = patterns.some((re) => re.test(tail))
  let resetAtText: string | null = null
  if (limited) {
    // Prefer the observed "resets 7:40pm (Europe/Budapest)" / "resets at 3pm"
    // form (time, optional am/pm, optional parenthesised TZ); fall back to the
    // looser "reset will ... at <text>" phrasing.
    const m =
      tail.match(/resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*\([^)]+\))?)/i) ||
      tail.match(/resets?\s+at\s+([^\n.]+)/i)
    if (m) resetAtText = m[1].trim()
  }
  return { limited, resetAtText }
}

// ---- default IO ----

function readMainToken(): string | null {
  try {
    const tokenPath = join(channelStateDir(PROVIDER, undefined), '.env')
    return readChannelToken(PROVIDER, tokenPath) || null
  } catch {
    return null
  }
}

function defaultDetectLimit(): LimitDetection {
  return classifyPane(capturePane(MAIN_CHANNELS_SESSION))
}

async function defaultSendTelegram(text: string): Promise<boolean> {
  const token = readMainToken()
  if (!token || !ALERT_CHAT_ID) {
    logger.debug('token-outage: no main token / chat id -- cannot send')
    return false
  }
  return sendFallbackAlert(token, ALERT_CHAT_ID, text)
}

function defaultCreateCard(pending: AgentMessage[], resetAtText: string | null, now: number): string | null {
  const id = randomUUID().slice(0, 8)
  const head = pending.length
    ? pending.map((m) => `- ${m.content.slice(0, 200)}`).join('\n')
    : '(no queued inbound captured -- operator notified)'
  createCard({
    id,
    title: `[Token-outage] ${pending.length} queued msg${pending.length === 1 ? '' : 's'} during Claude-limit`,
    description:
      `Claude account usage-limit window started ${new Date(now).toISOString()}.` +
      `${resetAtText ? ` Reset: ${resetAtText}.` : ''}\n\nQueued inbound for marveen:\n${head}`,
    status: 'waiting',
    priority: 'high',
    project: 'CORE', // canonical taxonomy (card cf0d1bfe): CORE owns token-usage/outage
  })
  return id
}

function defaultMsSinceLastRespawn(): number {
  try {
    const s = parseInt(readFileSync(RESPAWN_STAMP_FILE, 'utf-8').trim(), 10)
    if (Number.isFinite(s) && s > 0) return Date.now() - s * 1000
  } catch {
    /* absent/garbage -> treat as long ago */
  }
  return Number.POSITIVE_INFINITY
}

function defaultRedispatch(): boolean {
  const ok = resumeMarveenSession()
  // Stamp the shared file so the in-process channel-monitor / channel-watchdog
  // defer and don't double-respawn right after us.
  try {
    writeFileSync(RESPAWN_STAMP_FILE, String(Math.floor(Date.now() / 1000)))
  } catch (err) {
    logger.debug({ err }, 'token-outage: respawn-stamp write failed')
  }
  return ok
}

function defaultReadState(): OutageState {
  try {
    if (!existsSync(STATE_PATH)) return { ...EMPTY_STATE }
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    return parsed && typeof parsed === 'object' ? { ...EMPTY_STATE, ...parsed } : { ...EMPTY_STATE }
  } catch (err) {
    logger.debug({ err }, 'token-outage: state read failed, starting empty')
    return { ...EMPTY_STATE }
  }
}

function defaultWriteState(s: OutageState): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2))
  } catch (err) {
    logger.debug({ err }, 'token-outage: state write failed')
  }
}

// Select "Stop and wait for limit to reset" (option 1) so the session exits
// the interactive menu and self-heals when the limit resets, instead of staying
// permanently wedged on the modal until a human intervenes.
function defaultDismissModal(): void {
  try {
    execFileSync(TMUX, ['send-keys', '-t', `=${MAIN_CHANNELS_SESSION}:`, '1', 'Enter'], { timeout: 5000 })
    logger.info('token-outage: limit modal dismissed (Stop and wait selected)')
  } catch (err) {
    logger.warn({ err }, 'token-outage: modal dismiss send-keys failed')
  }
}

// Hard-relaunch the main session by killing it and running channels.sh fresh.
// Used as a fallback when the modal dismiss did not produce an EXITED event
// within staleOutageMs. The stale-outage path runs ONCE per window
// (staleLimitKilled flag) so it never loops.
function defaultRelaunchSession(): boolean {
  try {
    const CHANNELS_SH = join(PROJECT_ROOT, 'scripts', 'channels.sh')
    execFileSync(TMUX, ['kill-session', '-t', `=${MAIN_CHANNELS_SESSION}`], { timeout: 5000 })
    logger.warn('token-outage: stale-limit kill-session executed')
    // Spawn channels.sh detached so the current process (token-outage-cli)
    // outlives the session kill and exits cleanly before the new session starts.
    // execFileSync does not support detached: true (option silently ignored,
    // call blocks synchronously for 30 s then kills channels.sh). Use spawn +
    // unref() instead so the child outlives the token-outage-cli process.
    const child = spawn('/bin/bash', [CHANNELS_SH], { detached: true, stdio: 'ignore' })
    child.unref()
    logger.warn('token-outage: channels.sh relaunched after stale limit')
    try {
      writeFileSync(RESPAWN_STAMP_FILE, String(Math.floor(Date.now() / 1000)))
    } catch { /* best effort */ }
    return true
  } catch (err) {
    logger.error({ err }, 'token-outage: stale-relaunch failed')
    return false
  }
}

const DEFAULT_DEPS: OutageDeps = {
  detectLimit: defaultDetectLimit,
  sendTelegram: defaultSendTelegram,
  getQueue: () => getPendingMessages(MAIN_AGENT_ID),
  createCard: defaultCreateCard,
  msSinceLastRespawn: defaultMsSinceLastRespawn,
  redispatch: defaultRedispatch,
  dismissModal: defaultDismissModal,
  relaunchSession: defaultRelaunchSession,
  staleOutageMs: DEFAULT_STALE_OUTAGE_MS,
  readState: defaultReadState,
  writeState: defaultWriteState,
  redispatchBackoffMs: REDISPATCH_BACKOFF_MS,
}

// One sweep cycle. Edge-triggered: acts only on the healthy<->limited transition,
// so a 30s loop re-running it is a cheap no-op while nothing changes.
export async function runCycle(now: number = Date.now(), deps: OutageDeps = DEFAULT_DEPS): Promise<CycleResult> {
  const state = { ...deps.readState() }
  const det = deps.detectLimit()
  let transition: CycleResult['transition'] = 'none'
  let acked = false
  let captured = false
  let redispatched = false

  if (det.limited && !state.limited) {
    // ENTERING the outage: ACK once + snapshot the queue to kanban.
    transition = 'entered'
    state.limited = true
    state.enteredAtMs = now
    state.ackSent = false
    state.capturedCardId = null
    state.staleLimitKilled = false

    const msg =
      'Megkaptam, most Claude-limit van, sorba tettem, token-reset utan feldolgozom.' +
      (det.resetAtText ? ` Reset: ${det.resetAtText}.` : '')
    acked = await deps.sendTelegram(msg).catch(() => false)
    state.ackSent = acked

    let pending: AgentMessage[] = []
    try {
      pending = deps.getQueue()
    } catch (err) {
      logger.debug({ err }, 'token-outage: queue read failed')
    }
    // Card 9c067880 (Boss TG4726): only snapshot to kanban when there is actually
    // queued inbound to preserve. A 0-queued window is benign -- the operator is
    // already ACKed above -- so creating a [Token-outage] card for it is pure
    // board noise (5 such cards in 24h on 07-26). Skip the card, log only. The
    // edge-trigger already caps this at one card per window; the queued>0 guard
    // additionally suppresses the empty-window cards entirely.
    if (pending.length > 0) {
      try {
        state.capturedCardId = deps.createCard(pending, det.resetAtText, now)
        captured = !!state.capturedCardId
      } catch (err) {
        logger.debug({ err }, 'token-outage: kanban capture failed')
      }
    } else {
      logger.info('token-outage: entered a limit window with 0 queued inbound -- ACK sent, no card created (benign)')
    }

    // Auto-dismiss the interactive modal so the session can self-heal when the
    // limit resets. Without this, the pane stays permanently wedged on the
    // "Stop and wait / Upgrade" menu and never produces an EXITED event.
    try {
      deps.dismissModal()
    } catch (err) {
      logger.warn({ err }, 'token-outage: dismissModal threw unexpectedly')
    }
  } else if (!det.limited && state.limited) {
    // EXITING the outage (reset detected): back-online message + re-dispatch.
    transition = 'exited'
    state.limited = false
    state.staleLimitKilled = false
    acked = await deps.sendTelegram('Ujra elek, dolgozom a sorban allokon.').catch(() => false)

    // Only respawn if nobody respawned the main session very recently (avoids
    // racing the channel-monitor's own stall recovery into a double respawn).
    if (deps.msSinceLastRespawn() >= deps.redispatchBackoffMs) {
      try {
        redispatched = deps.redispatch()
      } catch (err) {
        logger.debug({ err }, 'token-outage: redispatch failed')
      }
    } else {
      logger.info('token-outage: skipping redispatch -- a recent respawn already covers it')
    }
    state.ackSent = false
    state.capturedCardId = null
  } else if (det.limited && state.limited && !state.staleLimitKilled) {
    // STALE outage: the session has been on the limit modal longer than
    // staleOutageMs without producing an EXITED event. The modal dismiss sent at
    // ENTERED apparently did not take effect. Hard-relaunch the session once as
    // a backstop. staleLimitKilled prevents a relaunch loop.
    if (now - state.enteredAtMs >= deps.staleOutageMs) {
      transition = 'stale-relaunch'
      logger.warn(
        { enteredAtMs: state.enteredAtMs, staleSec: Math.round((now - state.enteredAtMs) / 1000) },
        'token-outage: stale limit -- launching hard-relaunch',
      )
      try {
        deps.relaunchSession()
      } catch (err) {
        logger.warn({ err }, 'token-outage: relaunchSession threw unexpectedly')
      }
      state.staleLimitKilled = true
    }
  }

  deps.writeState(state)
  return { state, transition, acked, captured, redispatched }
}
