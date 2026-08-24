import { existsSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, BOT_NAME, CHANNEL_PROVIDER, PROJECT_ROOT, RESPAWN_ENABLED } from '../config.js'
import { agentDir, listAgentNames, readAgentChannelProviderSafe, readAgentModel, writeAgentModel } from './agent-config.js'
import {
  OPUS_FALLBACK_AGENTS,
  SONNET_FALLBACK,
  isOpusModel,
  detectOpusCapReason,
  decideOpusFallback,
  readOpusFallbackState,
  writeOpusFallbackState,
} from './opus-fallback.js'
import { markAgentCardsWaiting, OPUS_LIMIT_COMMENT } from './opus-fallback-kanban.js'
import {
  aggregateOpusBurn,
  decideBurnAlerts,
  readBurnAlertState,
  writeBurnAlertState,
} from './opus-burn-monitor.js'
import { createAgentMessage } from '../db.js'
import {
  agentHasChannel,
  agentSessionName,
  capturePane,
  dismissResumeSummaryModalIfPresent,
  isAgentRunning,
  isAgentChannelIntentionallyEnabled,
  sendPromptToSession,
  startAgentProcess,
  stopAgentProcess,
  scheduleIdentitySetup,
} from './agent-process.js'
import { reapChannelOrphans, reapDetachedChannelClaudes } from './channel-poller-reap.js'
import { probeTelegramConflict } from './channel-conflict-probe.js'
import { schedulePluginUnlockAfterRespawn } from './channel-plugin-unlock.js'
import { detectPaneState, decidePaneErrorAlert, detectsUsageLimitMenu, type PaneErrorAlertState, type PaneState } from '../pane-state.js'
import {
  decideUsageLimitRecovery,
  DEFAULT_USAGE_LIMIT_WEDGE_THRESHOLDS,
  type UsageLimitWedgeState,
} from './usage-limit-wedge.js'
import { MAIN_CHANNELS_SESSION, MAIN_CHANNELS_PLIST } from './main-agent.js'
import { notifyChannel } from '../notify.js'
import { getProvider, channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { attemptChannelMcpReconnect } from './channel-mcp-reconnect.js'
import { readLastIngestionTimestamp, readLastAssistantTimestamp, TRANSCRIPT_DIR } from './inbound-probe.js'
import { shouldAutoRestartDownAgent, parseEtimeToSeconds } from './agent-restart-policy.js'
// getClaudePidForSession + hasChannelPluginAlive live in the shared liveness
// module so the standalone channel-coordinator reuses the exact same probe.
import { getClaudePidForSession, hasChannelPluginAlive } from '../channel-coordinator/liveness.js'
import { getDesiredAgents } from './agent-desired-state.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')

// How long the agent's claude process has been running. Returns -1 when it
// cannot be determined, which the restart policy treats as "do not restart".
function getProcessAgeMs(pid: number): number {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'etime=', '-p', String(pid)], { timeout: 3000, encoding: 'utf-8' })
    const secs = parseEtimeToSeconds(out)
    return secs < 0 ? -1 : secs * 1000
  } catch {
    return -1
  }
}

function resolveAgentProvider(name: string): ChannelProviderType {
  // Fail-soft on an unreadable config (misconfigured secret pointer) -> default.
  const perAgent = readAgentChannelProviderSafe(name).provider
  if (perAgent === 'slack' || perAgent === 'telegram' || perAgent === 'discord') return perAgent
  return CHANNEL_PROVIDER
}

// --- Channel Plugin Health Monitor ---
// Detect when the channel plugin grandchild dies under a Claude session
// by walking the process tree. Agents recover via stop+start; for the
// main agent's channels session we can only alert + escalate, because
// killing it would terminate the live agent.

const agentDownSince: Map<string, number> = new Map()
const agentLastRestart: Map<string, number> = new Map()
// Per-agent usage-limit-modal wedge bookkeeping (confirm window + restart cap).
const agentUsageLimitWedge: Map<string, UsageLimitWedgeState> = new Map()
const CLEAN_USAGE_LIMIT_WEDGE_STATE: UsageLimitWedgeState = {
  consecutiveModalTicks: 0,
  lastRestartAtMs: null,
  restartCount: 0,
  escalationCount: 0,
}
const AGENT_RESTART_GRACE_MS = 90_000
// A freshly started agent can take well over the first-probe window to bring
// its channel plugin up (a large-context model launched with --continue spawns
// the plugin only after a slow session load). Never restart a process younger
// than this on a "plugin down" reading, or the watchdog crash-loops it.
const AGENT_STARTUP_GRACE_MS = 180_000
const PLUGIN_ALERT_DEDUP_MS = 30 * 60 * 1000

// Per-session tracking for the wedged thinking-block error (a Claude
// session stuck returning `400 ... thinking blocks cannot be modified`
// on every prompt). detectPaneState() classifies such a pane as
// 'error'; the monitor alerts so the operator can reset it. Alert-only
// by design -- auto-reset would destroy the agent's working memory and a
// false positive must not nuke a healthy session.
const paneErrorState: Map<string, PaneErrorAlertState> = new Map()
// Must persist for at least two monitor ticks (60s interval) before the
// first alert, so a one-tick transient never reports. 30 min dedup
// matches the channel-plugin alert cadence. clearMs (5 min) keeps a
// spell alive across brief non-error blips (null capture, mid-flight
// busy) so a flapping but genuinely wedged session still alerts.
const PANE_ERROR_CONFIRM_MS = 120_000
const PANE_ERROR_DEDUP_MS = 30 * 60 * 1000
const PANE_ERROR_CLEAR_MS = 5 * 60 * 1000

type MarveenRecoveryStage = 'soft' | 'save' | 'resume' | 'hard' | 'gave_up'
interface MarveenDownState {
  downSince: number
  stage: MarveenRecoveryStage
  lastAlertAt: number
  softAttempts: number
  stageStartedAt?: number
  // Set once we've issued the diagnostic getUpdates probe for this down-cycle,
  // so we don't spam the upstream API every poll while recovery is running.
  conflictProbed?: boolean
}

const SAVE_WINDOW_MS = 60_000
const MARVEEN_DOWN_CONFIRM_MS = 120_000
let marveenSuspectFirstSeen: number | null = null
let marveenDownState: MarveenDownState | null = null

function getMainAgentProvider(): ChannelProviderType {
  return CHANNEL_PROVIDER
}

function softReconnectMarveen(): boolean {
  return attemptChannelMcpReconnect(MAIN_AGENT_ID).ok
}

function triggerMarveenMemorySave(): void {
  const prompt = [
    '[SYSTEM: channels recovery] A csatorna plugin nem reagal, kb 60 masodperc',
    `mulva hard restart lesz a ${MAIN_CHANNELS_SESSION} session-on (a beszelgetes elveszik).`,
    'MOST mentsd el a ClaudeClaw memoriaba amit a kovetkezo sessionnek tudnia kell:',
    'aktiv feladatok (category hot), friss dontesek/preferenciak (warm), tanulsagok (cold).',
    'Hasznald: curl -s -X POST http://localhost:3420/api/memories ... (lasd CLAUDE.md).',
    'Ha kesz vagy, irj egy rovid napi naplo bejegyzest is a /api/daily-log-ra. Utana eleg.',
  ].join(' ')
  try {
    sendPromptToSession(MAIN_CHANNELS_SESSION, prompt)
    logger.info(`${BOT_NAME} memory-save prompt dispatched before hard restart`)
  } catch (err) {
    logger.warn({ err }, `Failed to dispatch ${BOT_NAME} memory-save prompt`)
  }
}

// Read the main agent's configured model from .claude/settings.json so a
// soft resume passes --model explicitly, mirroring scripts/channels.sh. Without
// it the respawned session falls back to claude-code's built-in default and
// silently drifts off the model the user picked. Returns '' when unset.
function readConfiguredMainModel(): string {
  try {
    const settingsPath = join(PROJECT_ROOT, '.claude', 'settings.json')
    if (!existsSync(settingsPath)) return ''
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const model = parsed?.model
    return typeof model === 'string' ? model.trim() : ''
  } catch {
    return ''
  }
}

// Build the claude command used to (re)spawn the main channels session via
// `tmux respawn-pane`. Pure + exported so the contract test can LOCK the
// presence of the `$HOME/.bun/bin` PATH export (without it the respawned bun
// telegram bridge can't be found and the session comes up channel-less). The
// PATH and flags mirror scripts/channels.sh. `continueSession` resumes the
// prior conversation (stage-3 recovery) vs a clean start (hard restart).
//
// NOTE: inbound from `--channels` also goes through the allowlist at
// /etc/claude-code/managed-settings.json (allowedChannelPlugins); a plugin not
// listed there has its MCP notifications silently dropped. See channels.sh.
export function buildMainSessionRespawnCmd(opts: {
  claudePath: string
  pluginId: string
  model: string
  continueSession: boolean
}): string {
  return [
    'export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    '&&', opts.claudePath,
    ...(opts.continueSession ? ['--continue'] : []),
    '--dangerously-skip-permissions',
    // Single-quote the model id so a value like `claude-opus-4-8[1m]` is not
    // glob-expanded by the shell that tmux respawn-pane spawns the command in.
    ...(opts.model ? ['--model', `'${opts.model}'`] : []),
    `--channels plugin:${opts.pluginId}`,
  ].join(' ')
}

// Exported so the standalone token-outage bridge can re-dispatch the queued
// inbound after a usage-limit reset by reusing this proven context-preserving
// --continue respawn (instead of duplicating the reap/modal/identity/unlock
// dance). Cross-process double-respawn is guarded via the .channel-last-respawn
// stamp file (see lastMainRespawnAt / fileRespawnStampMs).
export function resumeMarveenSession(): boolean {
  const provider = getProvider(getMainAgentProvider())
  try {
    // Reap any orphan bun/node poller BEFORE we respawn. tmux respawn-pane -k
    // kills the parent claude process but leaves grandchild pollers running -
    // see channel-poller-reap.ts. Without this, the freshly-respawned
    // --continue session would race a still-alive poller for the same bot
    // token (409 Conflict on getUpdates).
    try {
      reapChannelOrphans(provider.type, PROJECT_ROOT)
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: pre-respawn reap failed (continuing)')
    }

    // Also reap DETACHED main-session claudes. reapChannelOrphans (env-scan)
    // cannot see the main session: channels.sh launches it without a
    // *_STATE_DIR export, so neither the claude nor its bun poller match the
    // env needle, and bot.pid is never written. A --continue respawn that did
    // not tear down the prior claude leaves it detached (reparented to the tmux
    // server) with a live poller hammering the shared token. Pane attribution
    // spares the live session (this pane) and kills only the leftovers.
    // See project_channels_continue_respawn_leak.
    try {
      reapDetachedChannelClaudes({ tmuxPath: TMUX })
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: detached-claude reap failed (continuing)')
    }

    const claudeCmd = buildMainSessionRespawnCmd({
      claudePath: CLAUDE,
      pluginId: provider.pluginId,
      model: readConfiguredMainModel(),
      continueSession: true,
    })
    execFileSync(TMUX, ['respawn-pane', '-k', '-t', MAIN_CHANNELS_SESSION, claudeCmd], { timeout: 15000 })

    // --continue replays the last conversation. When the prior session is large
    // (>200k tokens) Claude Code opens with a "Resume from summary" modal that
    // parks the prompt - the plugin never reaches inbound-ready and stage 3
    // silently times out into stage 4. The agent-process startup path already
    // dismisses this modal; we mirror it here for the resume path.
    try {
      execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
      dismissResumeSummaryModalIfPresent(MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: post-respawn modal dismiss failed (continuing)')
    }

    // --continue replays the last conversation. When the prior session is
    // large (>200k tokens) Claude Code opens with a "Resume from summary"
    // modal that parks the prompt - the plugin never reaches the inbound-
    // ready state, detectPaneState stays 'unknown', and stage 3 silently
    // times out into stage 4. The agent-process startup path already dismisses
    // this modal; we do the same here so the resume path matches.
    try {
      execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
      dismissResumeSummaryModalIfPresent(MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: post-respawn modal dismiss failed (continuing)')
    }

    logger.warn({ provider: provider.type }, 'Marveen session respawned with --continue')
    // Re-establish /name on the brand-new claude process (the prior session's
    // identity is gone after respawn-pane; channels.sh sets it on a normal
    // start). /remote-control was dropped (the operator no longer uses it).
    scheduleIdentitySetup(MAIN_CHANNELS_SESSION, BOT_NAME)
    // channels.sh runs an /mcp+Up+Enter+Enter unlock probe after launching
    // the main session to revive a Failed/disabled channel plugin (#231/#232),
    // but THIS code path skips channels.sh entirely - tmux respawn-pane is
    // direct. Schedule the same probe in-process so the plugin doesn't get
    // stuck in `◯ disabled` after an in-process respawn (2026-06-01 18:55).
    schedulePluginUnlockAfterRespawn(MAIN_CHANNELS_SESSION, provider.type)
    return true
  } catch (err) {
    logger.error({ err }, 'Marveen session respawn failed')
    return false
  }
}

// Grace history: 90s -> 150s -> 240s.
// 2026-06-01 16:31 incident: with the reap+modal-dismiss path landed,
// resumeMarveenSession respawned cleanly, but a >200k-token --continue
// session-load + plugin re-handshake exceeded the 150s window and stage 4
// fired anyway (context lost). Bumped to 240s so the slowest realistic
// large-context resume completes inside the window. The monitor polls every
// 60s, so the effective resolution rounds up to the next poll - 240s gives
// 3-4 polls' worth of slack before the hard restart escalates.
const RESUME_GRACE_MS = 240_000
let marveenLastHardRestart = 0
// Post-respawn cold-start grace. After ANY main-session respawn (keepalive
// fresh-respawn, stage-3 resume, or stage-4 hard restart) the new claude needs
// minutes to load its large context and complete the channel-plugin handshake.
// The 2026-06-01 480s outage was self-inflicted churn: a keepalive fresh-respawn
// at 17:59:20 was followed by a down-detect at 18:03 because this grace was only
// 120s -- it expired mid cold-start, so soft->save->resume->hard piled THREE
// restarts onto a session that was merely still booting. 6 min comfortably
// covers the slowest realistic cold start while staying under the 18-min
// keepalive-staleness net, so a session that is genuinely dead after a respawn
// is still caught by another path. Exported so the stuck-tool-call-watcher
// shares the same post-respawn grace (single source of truth).
export const MARVEEN_POST_RESPAWN_GRACE_MS = 360_000

// Pure: the most recent main-session respawn time across all three writers --
// the keepalive path (marveenLastKeepaliveRespawn), the hard-restart/inbound path
// (marveenLastHardRestart) and the external file-stamp watchdog. This fold is what
// mediates "which path defers to which": whoever stamped LAST wins, and the others
// read it back via lastMainRespawnAt() and suppress. Extracted so the combined
// two-path defer interaction is unit-testable (Thor T6).
export function mostRecentRespawn(keepaliveAt: number, hardRestartAt: number, fileStampAtMs: number): number {
  return Math.max(keepaliveAt, hardRestartAt, fileStampAtMs)
}

// Pure: should a recovery path DEFER its respawn because another path (or this
// one) respawned recently? True only when there is a prior respawn (>0) and we
// are still inside the grace window. Both the keepalive and hard-restart paths
// gate on this via lastMainRespawnAt(), so a respawn from EITHER path suppresses
// the other -- this is what stops the restart-on-restart stacking (2026-06-01).
export function shouldDeferRespawn(now: number, lastRespawnAt: number, graceMs: number): boolean {
  return lastRespawnAt > 0 && (now - lastRespawnAt) < graceMs
}

/**
 * B2 fix: shared cross-path grace accessor.
 * Returns the wall-clock time (ms since epoch) of the most recent main-session
 * respawn, regardless of which path triggered it (keepalive or inbound-probe).
 * Both paths check this before firing so they cannot double-respawn within
 * KEEPALIVE_RESPAWN_GRACE_MS of each other.
 */
export function lastMainRespawnAt(): number {
  return mostRecentRespawn(marveenLastKeepaliveRespawn, marveenLastHardRestart, fileRespawnStampMs())
}

// Cross-LAYER coordination with the independent systemd-timer watchdog
// (scripts/channel-watchdog.sh). That timer writes RESPAWN_STAMP_FILE (epoch
// SECONDS) when IT respawns; reading it here means an out-of-process respawn
// also suppresses this in-process watchdog for the grace window. Symmetrically,
// hardRestartMarveenChannels writes the same file so the timer defers to us.
// Best-effort: 0 if absent/garbage.
const RESPAWN_STAMP_FILE = join(PROJECT_ROOT, 'store', '.channel-last-respawn')
function fileRespawnStampMs(): number {
  try {
    const s = parseInt(readFileSync(RESPAWN_STAMP_FILE, 'utf-8').trim(), 10)
    return Number.isFinite(s) && s > 0 ? s * 1000 : 0
  } catch {
    return 0
  }
}
function writeRespawnStamp(): void {
  try {
    writeFileSync(RESPAWN_STAMP_FILE, String(Math.floor(Date.now() / 1000)))
  } catch { /* best effort */ }
}

// Hard-restart fallback when there is no systemd unit to bounce: respawn the
// tmux pane with a FRESH claude (no --continue). Mirrors resumeMarveenSession
// but starts a clean session -- exactly what scripts/channels.sh does -- so a
// wedged plugin gets a brand-new process even on pure-tmux installs. Distinct
// from the stage-3 resume (which keeps --continue) by clearing session state.
function respawnMarveenSessionFresh(): boolean {
  const provider = getProvider(getMainAgentProvider())
  try {
    const claudeCmd = buildMainSessionRespawnCmd({
      claudePath: CLAUDE,
      pluginId: provider.pluginId,
      model: readConfiguredMainModel(),
      continueSession: false,
    })
    execFileSync(TMUX, ['respawn-pane', '-k', '-t', MAIN_CHANNELS_SESSION, claudeCmd], { timeout: 15000 })
    logger.warn({ provider: provider.type }, 'Hard restart: marveen session respawned fresh (no --continue)')
    // Re-establish /name on the fresh process (see note in resumeMarveenSession).
    scheduleIdentitySetup(MAIN_CHANNELS_SESSION, BOT_NAME)
    // Same channels.sh-bypass concern as in resumeMarveenSession: this respawn
    // path does NOT invoke channels.sh, so the post-init plugin unlock probe
    // (#231/#232) never runs. Wire it in-process so the keep-alive-watchdog
    // fresh-respawn path also revives a Failed/disabled plugin instead of
    // leaving the channel offline until manual intervention.
    schedulePluginUnlockAfterRespawn(MAIN_CHANNELS_SESSION, provider.type)
    writeRespawnStamp() // coordinate with the systemd-timer watchdog (covers the keepalive path too)
    return true
  } catch (err) {
    logger.error({ err }, 'Fresh session respawn failed')
    return false
  }
}

export function hardRestartMarveenChannels(): { ok: boolean; error?: string } {
  // macOS: bounce the launchd job (its own process group -- safe).
  if (process.platform !== 'linux') {
    try {
      execFileSync('/bin/launchctl', ['unload', MAIN_CHANNELS_PLIST], { timeout: 5000 })
      execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
      execFileSync('/bin/launchctl', ['load', MAIN_CHANNELS_PLIST], { timeout: 5000 })
      logger.warn(`Hard restart: launchctl reload of com.${MAIN_AGENT_ID}.channels`)
      marveenLastHardRestart = Date.now()
      writeRespawnStamp() // coordinate with the systemd-timer watchdog
      return { ok: true }
    } catch (err) {
      logger.error({ err }, 'Hard restart failed (launchctl)')
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // Linux: respawn-pane ONLY -- NEVER `systemctl --user restart`. The channels
  // unit (e.g. marveen-channels.service) runs with KillMode=control-group and
  // the shared tmux SERVER lives in its cgroup, so restarting the unit kills the
  // tmux server and with it EVERY agent session, not just the main one.
  // respawn-pane replaces only the claude process in the main channels pane,
  // leaving the server and all other sessions intact.
  if (respawnMarveenSessionFresh()) {
    marveenLastHardRestart = Date.now()
    return { ok: true }
  }
  return { ok: false, error: 'hard restart failed: tmux respawn-pane failed' }
}

// --- Keep-alive staleness watchdog (deafness safety net, decision #3) ---
//
// The keep-alive (a scheduled edit_message round-trip from the channels
// session) touches store/.channel-keepalive on every success. If that file
// goes stale while the session is otherwise process-alive, the MCP stdio pipe
// is likely wedged -> respawn the pane.
//
// LIMITATION (documented on purpose): this staleness net does NOT catch a clean
// inbound-ONLY deafness, where outbound edit_message still succeeds and keeps the
// file fresh while server->claude notifications are dropped. The keep-alive
// PREVENTS that case (warm pipe); the ACTIVE detector for it now ships as
// src/web/inbound-probe.ts (2026-06-01) -- a userbot sends a marker the watchdog
// verifies in the transcript. This staleness path remains the coarse backstop.
const KEEPALIVE_FILE = join(PROJECT_ROOT, 'store', '.channel-keepalive')
const KEEPALIVE_STALE_MS = 18 * 60 * 1000 // ~3 missed 6-min cycles
const KEEPALIVE_RESPAWN_GRACE_MS = 15 * 60 * 1000 // let a respawned session re-establish the file
let marveenLastKeepaliveRespawn = 0

/**
 * Pure decision: should the keepalive respawn be deferred because the
 * main session pane is actively busy?
 *
 * Returns true (defer) for 'busy' | 'typing'.
 * Returns false (proceed) for 'idle' | 'unknown' | 'error' | null.
 *
 * Fail-OPEN on unknown/error/null: a wedged or unreadable pane must still
 * be recoverable. Never block a respawn because we couldn't read the pane.
 */
export function shouldDeferKeepaliveRespawn(
  paneState: PaneState | null
): boolean {
  return paneState === 'busy' || paneState === 'typing'
}

// Pure decision: respawn only when the file EXISTS but has gone stale (a file
// that was once fresh and stopped updating). A missing file means the keep-
// alive hasn't established a baseline yet (fresh boot) -- never respawn on
// absence, or we'd loop before the first keep-alive runs.
export function shouldRespawnForStaleKeepalive(opts: {
  keepaliveAgeMs: number | null
  stalenessThresholdMs: number
  msSinceLastRespawn: number | null
  respawnGraceMs: number
}): boolean {
  if (opts.keepaliveAgeMs == null) return false
  if (opts.msSinceLastRespawn != null && opts.msSinceLastRespawn < opts.respawnGraceMs) return false
  return opts.keepaliveAgeMs > opts.stalenessThresholdMs
}

// SOURCE FIX (2026-06-01): the staleness watchdog's only health signal was the
// scheduled edit_message round-trip, injected into the SAME busy channels
// session. When the session is busy carrying a real conversation, that prompt
// is skipped/stuck, so the keepalive file ages WHILE THE CHANNEL IS PERFECTLY
// ALIVE -- and the watchdog respawned the live conversation in an idle gap.
//
// Real inbound traffic is direct proof the server->claude pipe is alive (it is
// exactly that pipe which dies in a deafness). So the dashboard advances the
// keepalive file's mtime to the timestamp of the last ingested `<channel
// source=` block. Now an active conversation keeps the file warm -- precisely
// when it used to go stale -- while a genuinely silent/deaf session still ages
// out. Both watchdogs (this one + the systemd timer) key off the file mtime, so
// both benefit. The scheduled edit_message round-trip stays as the IDLE-path
// keep-alive (no organic traffic); its busy-skip no longer causes false
// staleness because organic inbound covers the busy case.

// Pure decision: should the keepalive file be advanced to the last-inbound
// timestamp? Only when there IS a last inbound and it is newer than the file
// (never move the mtime backward; the scheduled keepalive may be more recent).
export function shouldRefreshKeepaliveFromInbound(
  lastInboundTs: number | null,
  keepaliveMtimeMs: number,
): boolean {
  return lastInboundTs != null && lastInboundTs > keepaliveMtimeMs
}

// Side-effecting: advance store/.channel-keepalive's mtime to the last ingested
// inbound message time, so live conversation proves the pipe healthy. Best
// effort; never throws into the monitor tick.
function refreshKeepaliveFromInbound(): void {
  try {
    const lastInboundTs = readLastIngestionTimestamp(TRANSCRIPT_DIR)
    let mtimeMs = 0
    try { mtimeMs = statSync(KEEPALIVE_FILE).mtimeMs } catch { /* missing -> 0 */ }
    if (!shouldRefreshKeepaliveFromInbound(lastInboundTs, mtimeMs)) return
    if (!existsSync(KEEPALIVE_FILE)) {
      writeFileSync(KEEPALIVE_FILE, String(Math.floor((lastInboundTs as number) / 1000)))
    }
    const when = new Date(lastInboundTs as number)
    utimesSync(KEEPALIVE_FILE, when, when)
  } catch (err) {
    logger.debug({ err }, 'refreshKeepaliveFromInbound failed (non-fatal)')
  }
}

function checkMainKeepaliveStaleness(): void {
  // SAFETY NET first: let any fresh inbound traffic warm the file before we
  // judge staleness, so a busy-but-alive session is never seen as stale-deaf.
  refreshKeepaliveFromInbound()

  // GROUND-TRUTH SHORTCUT (2026-06-01 21:18 incident): if the channel
  // plugin's bun poller is ALIVE under Marveen's claude pid, the channel
  // is healthy by definition -- Telegram traffic CAN reach us. A stale
  // keepalive file with a live poller is just a quiet conversation, NOT
  // deafness. Respawning here would kill the session for nothing (Szabi
  // got "channel keep-alive 18 perce nem frissült" alerts every 30 min
  // during idle periods, each one losing the running --continue context).
  // The bun-child check is the same liveness signal channel-plugin-unlock
  // already uses; reuse it here so the two paths agree on "alive".
  try {
    const claudePid = getClaudePidForSession(MAIN_CHANNELS_SESSION)
    if (claudePid != null) {
      const provider = getProvider(getMainAgentProvider())
      if (hasChannelPluginAlive(claudePid, provider.type)) {
        logger.debug({ claudePid, provider: provider.type }, 'Keepalive stale but channel plugin is alive -- skipping respawn')
        return
      }
    }
  } catch (err) {
    // Fail-open: if we couldn't probe liveness, fall through to the
    // existing staleness path so a genuinely dead session still recovers.
    logger.debug({ err }, 'Keepalive liveness shortcut probe failed, falling through')
  }

  let ageMs: number | null = null
  try {
    ageMs = Date.now() - statSync(KEEPALIVE_FILE).mtimeMs
  } catch {
    ageMs = null // file missing -> keep-alive not yet established
  }
  const now = Date.now()
  // B2 fix: cross-path grace — use the later of the two respawn timestamps so
  // an inbound-probe respawn also suppresses the keepalive path for the grace window.
  const msSinceLastRespawn = lastMainRespawnAt() ? now - lastMainRespawnAt() : null
  const respawn = shouldRespawnForStaleKeepalive({
    keepaliveAgeMs: ageMs,
    stalenessThresholdMs: KEEPALIVE_STALE_MS,
    msSinceLastRespawn,
    respawnGraceMs: KEEPALIVE_RESPAWN_GRACE_MS,
  })
  if (!respawn) return
  // Busy-guard: do not respawn a pane that is actively processing a turn.
  // capturePane returns null if the pane can't be read; detectPaneState
  // returns 'unknown' for null input — shouldDeferKeepaliveRespawn is
  // fail-open on unknown, so a broken capture never blocks recovery.
  const paneContent = capturePane(MAIN_CHANNELS_SESSION)
  const paneState = paneContent != null ? detectPaneState(paneContent) : null
  if (shouldDeferKeepaliveRespawn(paneState)) {
    logger.info({ paneState }, 'Keepalive stale but pane is busy -- deferring respawn')
    return
  }
  const ageMin = Math.round((ageMs ?? 0) / 60000)
  logger.warn({ ageMs, paneState }, 'Channel keep-alive stale -- main session likely wedged/deaf, respawning via respawn-pane')
  sendAlert(`⚠️ A fő channel keep-alive ${ageMin} perce nem frissült -- respawn-pane a ${MAIN_CHANNELS_SESSION} session-on (a beszelgetes elveszik, memoria marad).`)
  if (respawnMarveenSessionFresh()) {
    marveenLastKeepaliveRespawn = now
    // Suppress the process-down handler during the respawn window (reuses the
    // existing hard-restart grace) so the two recovery paths don't collide.
    marveenLastHardRestart = now
  }
}

// --- Main-session STALL watchdog (queued-input-but-no-progress, decision #1) ---
//
// The 2026-06-03 incident: marveen-channels stopped processing for 10h+. Dominik's
// messages 19:15-22:14 were INGESTED into the transcript (queued) but never acted
// on -- no crash, no 429, a pure STALL (hung MCP pipe / input-queue wedge). Every
// existing detector missed it because they all key off "is inbound arriving / is
// the poller alive", which were ALL TRUE during the stall:
//   - keepalive staleness: refreshKeepaliveFromInbound advanced the file to the
//     last INGESTED inbound ts -> looked fresh.
//   - plugin liveness: the bun poller was alive (receiving) -> "quiet conversation".
//   - inbound-probe: ingestion WAS happening (real msgs) -> not "deaf".
// The missing signal is whether the agent is PROCESSING: a healthy session appends
// `assistant` transcript entries as a turn produces output; a stalled one does not.
// So compare last-inbound-ingestion vs last-assistant-activity: inbound newer than
// the last assistant turn by > threshold = queued-but-no-progress = STALL.
//
// Threshold 10 min (Dominik 2026-06-04): a legitimate long reasoning turn does not
// false-positive, the 10h void recovers within ~10 min, and it sits under the 18-min
// keepalive net. Recovery = context-PRESERVING `--continue` respawn (resumeMarveenSession);
// the transcript is replayed so the conversation survives -- no cooperation needed
// from the wedged session (a memory-save prompt would never be processed in a stall).
const STALL_THRESHOLD_MS = 10 * 60 * 1000
// Token-awareness (decision #2): if the stall is rate-limit/no-token driven, a
// respawn won't help and we must not hammer. Enforce a 30-min minimum between
// stall recoveries; when the token returns, the session comes back on a respawn
// and the heartbeat recovery routine (memory-heartbeat SKILL) re-engages.
const STALL_RECOVERY_BACKOFF_MS = 30 * 60 * 1000
let marveenLastStallRecovery = 0

/**
 * Pure decision: should the main session be recovered for a queued-input stall?
 *
 * Stall = inbound has been ingested but no assistant turn has advanced past it,
 * and that has held longer than the threshold. Guards:
 *   - no inbound recorded -> nothing queued -> false
 *   - last assistant activity is at/after the last inbound -> already progressed -> false
 *   - inbound newer than threshold ago is not yet a stall -> false
 *   - within a recent main-session respawn's cold-start window -> false (booting)
 *   - within the stall-recovery backoff -> false (don't hammer a 429/no-token stall)
 *
 * Pure + exported so the incident timeline and every false-positive guard are
 * unit-tested without touching tmux or the transcript.
 */
export function shouldRecoverStalledQueue(opts: {
  lastInboundTs: number | null
  lastProgressTs: number | null
  stallThresholdMs: number
  nowMs: number
  msSinceLastMainRespawn: number | null
  respawnGraceMs: number
  msSinceLastStallRecovery: number | null
  stallBackoffMs: number
}): boolean {
  const {
    lastInboundTs, lastProgressTs, stallThresholdMs, nowMs,
    msSinceLastMainRespawn, respawnGraceMs, msSinceLastStallRecovery, stallBackoffMs,
  } = opts
  if (lastInboundTs == null) return false
  if (lastProgressTs != null && lastProgressTs >= lastInboundTs) return false
  if (nowMs - lastInboundTs < stallThresholdMs) return false
  if (msSinceLastMainRespawn != null && msSinceLastMainRespawn < respawnGraceMs) return false
  if (msSinceLastStallRecovery != null && msSinceLastStallRecovery < stallBackoffMs) return false
  return true
}

// Side-effecting: detect a main-session queued-input stall and, when confirmed,
// alert + context-preserving --continue respawn. Called from the monitor tick
// only on the "plugin alive" main-session branch -- exactly the state the stall
// hides in (plugin up, session not processing). Read-only until the decision
// fires, so a healthy session is never disturbed.
function checkMainSessionStall(): void {
  const now = Date.now()
  const lastInboundTs = readLastIngestionTimestamp(TRANSCRIPT_DIR)
  const lastProgressTs = readLastAssistantTimestamp(TRANSCRIPT_DIR)
  const lastRespawn = lastMainRespawnAt()
  const recover = shouldRecoverStalledQueue({
    lastInboundTs,
    lastProgressTs,
    stallThresholdMs: STALL_THRESHOLD_MS,
    nowMs: now,
    msSinceLastMainRespawn: lastRespawn ? now - lastRespawn : null,
    respawnGraceMs: MARVEEN_POST_RESPAWN_GRACE_MS,
    msSinceLastStallRecovery: marveenLastStallRecovery ? now - marveenLastStallRecovery : null,
    stallBackoffMs: STALL_RECOVERY_BACKOFF_MS,
  })
  if (!recover) return
  const stalledMin = Math.round((now - (lastInboundTs as number)) / 60000)
  logger.warn(
    { lastInboundTs, lastProgressTs, stalledMin },
    'Main session STALLED: inbound queued but no assistant progress -- context-preserving --continue respawn',
  )
  sendAlert(`⚠️ A fő session ${stalledMin} perce nem dolgozza fel a beérkezett üzeneteket (queued, de nincs progress). Context-megőrző --continue respawn most a ${MAIN_CHANNELS_SESSION} session-on...`)
  if (resumeMarveenSession()) {
    marveenLastStallRecovery = now
    // Fold into the cross-path grace so the keepalive / down / inbound-probe
    // paths all defer during this respawn's cold start (no restart stacking).
    marveenLastHardRestart = now
  }
}

function sendAlert(text: string): void {
  notifyChannel(text).catch(() => {})
}

function handleMarveenDown(): void {
  const now = Date.now()
  const providerLabel = getMainAgentProvider()
  // Cold-start guard: defer the ENTIRE down cascade while a recent respawn
  // (from any recovery path -- keepalive fresh-respawn, stage-3 resume, stage-4
  // hard restart, or the external watchdog's file stamp) is still inside its
  // boot window. lastMainRespawnAt() folds all three timestamps together, so a
  // keepalive respawn that did NOT touch marveenLastHardRestart still suppresses
  // escalation. This is what stops the restart-on-restart stacking that caused
  // the 2026-06-01 480s outage (see MARVEEN_POST_RESPAWN_GRACE_MS).
  const lastRespawn = lastMainRespawnAt()
  if (shouldDeferRespawn(now, lastRespawn, MARVEEN_POST_RESPAWN_GRACE_MS)) {
    return
  }
  if (!marveenDownState) {
    marveenDownState = { downSince: now, stage: 'soft', lastAlertAt: now, softAttempts: 0 }
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin down -- stage 1 (soft /mcp reconnect, silent)')
    // Diagnostic 409 probe (Telegram only). Fire-and-forget so the sync
    // check-loop is not blocked on a network call. Logs explicitly when the
    // upstream returns the orphan-poller's "terminated by other getUpdates
    // request" message, so dashboard.log carries hard evidence of the real
    // cause instead of leaving the operator to infer it from a pane scan.
    if (providerLabel === 'telegram' && !marveenDownState.conflictProbed) {
      marveenDownState.conflictProbed = true
      const tokenPath = join(channelStateDir(providerLabel, PROJECT_ROOT), '.env')
      const tok = readChannelToken(providerLabel, tokenPath)
      if (tok) {
        probeTelegramConflict(tok)
          .then(r => {
            if (r.conflicted) {
              logger.warn(
                { status: r.status, description: r.description },
                'Telegram getUpdates 409 Conflict confirmed -- orphan poller is contending for the bot token. Recovery will reap and respawn.',
              )
            } else if (r.status > 0) {
              logger.info(
                { status: r.status, description: r.description },
                'Telegram getUpdates returned non-409 status on diagnostic probe -- the down state has a different cause than orphan poller contention',
              )
            }
          })
          .catch(err => {
            logger.warn({ err }, 'Telegram conflict probe failed to complete')
          })
      }
    }
    if (softReconnectMarveen()) marveenDownState.softAttempts += 1
    return
  }
  if (marveenDownState.stage === 'soft') {
    if (marveenDownState.softAttempts < 3 && softReconnectMarveen()) {
      marveenDownState.softAttempts += 1
      marveenDownState.lastAlertAt = now
      return
    }
    marveenDownState.stage = 'save'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 2 (memory save)')
    triggerMarveenMemorySave()
    return
  }
  if (marveenDownState.stage === 'save') {
    const saveStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
    if (now - saveStartedAt < SAVE_WINDOW_MS) return
    marveenDownState.stage = 'resume'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 3 (session resume)')
    resumeMarveenSession()
    return
  }
  if (marveenDownState.stage === 'resume') {
    const resumeStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
    if (now - resumeStartedAt < RESUME_GRACE_MS) return
    marveenDownState.stage = 'hard'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 4 (hard restart)')
    const svcName = process.platform === 'linux' ? 'systemctl' : 'launchctl'
    sendAlert(`⚠️ Session resume nem segitett. Hard restart (${svcName}) most a ${MAIN_CHANNELS_SESSION} session-on...`)
    hardRestartMarveenChannels()
    return
  }
  if (marveenDownState.stage === 'hard') {
    marveenDownState.stage = 'gave_up'
    marveenDownState.lastAlertAt = now
    logger.error({ provider: providerLabel }, 'Marveen channel plugin still down after hard restart -- giving up auto-recovery')
    const serviceCmd = process.platform === 'linux'
      ? `\`systemctl --user status ${MAIN_AGENT_ID}-channels\``
      : `\`launchctl list | grep ${MAIN_AGENT_ID}\``
    // Issue #189: a plain `tmux attach -t ...` may itself fail with "Permission
    // denied" when the operator is running it from another tmux session. Prefix
    // with `unset TMUX` so the hint works in both nested and non-nested cases.
    sendAlert(`🚨 Hard restart SEM segitett. Kezzel kell megnezni: \`unset TMUX && tmux attach -t ${MAIN_CHANNELS_SESSION}\` es ${serviceCmd}.`)
    return
  }
  if (now - marveenDownState.lastAlertAt > PLUGIN_ALERT_DEDUP_MS) {
    marveenDownState.lastAlertAt = now
    sendAlert(`🚨 NoA ${providerLabel} plugin meg mindig halott. Nezd meg kezzel.`)
  }
}

function handleMarveenUp(): void {
  marveenSuspectFirstSeen = null
  if (marveenDownState) {
    const downedFor = Math.round((Date.now() - marveenDownState.downSince) / 1000)
    const stage = marveenDownState.stage
    const providerLabel = getMainAgentProvider()
    logger.info({ stage, downedFor, provider: providerLabel }, 'Marveen channel plugin recovered')
    if (stage !== 'soft' && stage !== 'save' && stage !== 'resume') {
      sendAlert(`✅ NoA ${providerLabel} plugin helyrealt (${stage} utan, ${downedFor}s kieses).`)
    }
    marveenDownState = null
  }
}

function shouldEscalateMarveenDown(): boolean {
  const now = Date.now()
  if (marveenSuspectFirstSeen === null) {
    marveenSuspectFirstSeen = now
    return false
  }
  return now - marveenSuspectFirstSeen >= MARVEEN_DOWN_CONFIRM_MS
}

// Opus burn early-warning (card 1584cad7). Called every 30 min from
// startChannelPluginMonitor. Sends inter-agent messages to marveen at
// 70% / 90% of the weekly Opus credit limit (deduped per week via file state).
function checkOpusBurnThresholds(): void {
  try {
    const result = aggregateOpusBurn(Date.now())
    const state = readBurnAlertState()
    const alerts = decideBurnAlerts(result, state)
    for (const alert of alerts) {
      logger.warn(
        { level: alert.level, burnPct: result.burnPct.toFixed(1), totalBurnTokens: result.totalBurnTokens },
        `[opus-burn] ${alert.level} threshold crossed`,
      )
      let sent = false
      try {
        createAgentMessage('server', MAIN_AGENT_ID, alert.message, false, alert.priority)
        sent = true
      } catch (err) {
        logger.warn({ err }, '[opus-burn] failed to send alert message -- will retry next tick')
      }
      // Only persist dedup state if the message actually went out.
      // If the DB insert failed, the next 30-min check will retry rather than
      // silently marking the alert as sent.
      if (sent) writeBurnAlertState(alert.nextState)
    }
  } catch (err) {
    logger.warn({ err }, '[opus-burn] threshold check failed -- non-fatal')
  }
}

export function startChannelPluginMonitor(): NodeJS.Timeout | null {
  // Respawn/keep-alive is production-only. On any non-production host (e.g. a
  // local dev checkout) we never respawn the main agent or auto-restart
  // sub-agents -- otherwise two machines would fight over the same bot tokens.
  // Applies to ALL agents because the whole monitor loop is skipped here.
  if (!RESPAWN_ENABLED) {
    logger.info({ host: hostname() }, 'Channel plugin monitor disabled (respawn is production-only)')
    return null
  }

  const mainProvider = getMainAgentProvider()

  function check() {
    type Target = { session: string; isMarveen: boolean; agentName?: string; provider: ChannelProviderType }
    const targets: Target[] = [{ session: MAIN_CHANNELS_SESSION, isMarveen: true, provider: mainProvider }]
    for (const a of listAgentNames()) {
      // isAgentChannelIntentionallyEnabled guards against restart-looping a
      // channel-less agent (e.g. an inter-agent-only sub-agent) that merely has
      // a stale token file in its state dir but no live channel plugin. The
      // config-dir settings.json written by ensureAgentConfigDir is channel-
      // neutral (plugin keys stripped), so a channel-less agent returns false
      // here and is never added to the plugin-health watch list.
      if (isAgentRunning(a) && agentHasChannel(a) && isAgentChannelIntentionallyEnabled(a)) {
        targets.push({
          session: agentSessionName(a),
          isMarveen: false,
          agentName: a,
          provider: resolveAgentProvider(a),
        })
      }
    }

    // Pane-level thinking-block error detection. Independent of channel
    // plugin liveness: a session can keep a live plugin yet be wedged on
    // the API error, every injected prompt yielding another 400. Detect
    // it via the pane state and alert (never auto-reset).
    for (const t of targets) {
      const pane = capturePane(t.session)
      const isError = pane != null && detectPaneState(pane) === 'error'
      const prev = paneErrorState.get(t.session) ?? { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }
      const decision = decidePaneErrorAlert(isError, prev, Date.now(), {
        confirmMs: PANE_ERROR_CONFIRM_MS,
        dedupMs: PANE_ERROR_DEDUP_MS,
        clearMs: PANE_ERROR_CLEAR_MS,
      })
      if (decision.next.firstSeenAt === null) {
        paneErrorState.delete(t.session)
      } else {
        paneErrorState.set(t.session, decision.next)
      }
      if (decision.alert) {
        const label = t.isMarveen ? BOT_NAME : (t.agentName ?? t.session)
        logger.error({ session: t.session, agent: label }, 'Agent wedged on thinking-block API error -- manual reset needed')
        sendAlert(`🚨 A(z) ${label} agens elakadt egy thinking-block API hibaban (a session-history korrupt, minden uj prompt ugyanazt a 400-at adja). Kezi reset kell: allitsd le es inditsd ujra, friss session indul. Reszletek: tmux attach -t ${t.session}`)
      }

      // Opus weekly-cap fallback (card 339d0a36): if the pane shows a usage-
      // limit banner AND the agent currently runs Opus, switch it to Sonnet and
      // stop the process (watchdog restarts it from the updated agent-config.json).
      // On Sunday >= 10:00 UTC (Anthropic weekly reset) the original Opus model
      // is restored the same way. Only the agents in OPUS_FALLBACK_AGENTS are
      // checked; all others already run Sonnet by default.
      if (!t.isMarveen && t.agentName && OPUS_FALLBACK_AGENTS.includes(t.agentName)) {
        const capReason = pane != null ? detectOpusCapReason(pane) : null
        const capSignal = capReason !== null
        const allFallbackState = readOpusFallbackState()
        const agentFallbackState = allFallbackState[t.agentName] ?? { fallbackActive: false, originalModel: null, activeSince: null }
        const currentModel = readAgentModel(t.agentName)
        const nowMs = Date.now()
        const fallbackDecision = decideOpusFallback({ paneHasCapSignal: capSignal, currentModel, state: agentFallbackState, nowMs })
        if (fallbackDecision.action === 'activate') {
          // Write-order fix (card 4c800b62 #3): model write first, state second.
          // If writeAgentModel throws, fallback state stays inactive -> re-detect on next tick.
          writeAgentModel(t.agentName, SONNET_FALLBACK)
          writeOpusFallbackState({ ...allFallbackState, [t.agentName]: { fallbackActive: true, originalModel: currentModel, activeSince: nowMs, activationReason: capReason ?? 'weekly-cap', deactivatedAt: null } })
          // Graceful degradation (card 75a5ecc3): move in_progress cards to
          // waiting so they are not silently stuck while the agent is offline.
          // Wrapped in try-catch so a SQLite error never prevents stopAgentProcess
          // (Thor MINOR: if markAgentCardsWaiting throws, the agent would stay on
          // Opus while state says fallback=true -> zombie state).
          let moved = 0
          try {
            moved = markAgentCardsWaiting(t.agentName, OPUS_LIMIT_COMMENT)
          } catch (err) {
            logger.warn({ err, agent: t.agentName }, '[opus-fallback] markAgentCardsWaiting failed (non-fatal, continuing to stopAgentProcess)')
          }
          logger.warn({ agent: t.agentName, originalModel: currentModel, cardsMovedToWaiting: moved, capReason }, '[opus-fallback] cap detected -- switched to Sonnet, watchdog will restart')
          sendAlert(`⚠️ ${t.agentName}: Opus cap detektálva (${capReason ?? 'unknown'}). Sonnet-fallbackre váltva (${SONNET_FALLBACK}). ${moved > 0 ? `${moved} kártya waiting-re állítva. ` : ''}Reset után automatikusan visszaáll.`)
          stopAgentProcess(t.agentName)
        } else if (fallbackDecision.action === 'deactivate') {
          const rawOrig = fallbackDecision.originalModel
          const origModel = (rawOrig && isOpusModel(rawOrig)) ? rawOrig : 'claude-opus-4-8'
          // Write-order fix (card 4c800b62 #3): model write first, state second.
          writeAgentModel(t.agentName, origModel)
          writeOpusFallbackState({ ...allFallbackState, [t.agentName]: { fallbackActive: false, originalModel: null, activeSince: null, activationReason: null, deactivatedAt: nowMs } })
          logger.info({ agent: t.agentName, model: origModel }, '[opus-fallback] reset -- restoring Opus model, watchdog will restart')
          sendAlert(`✅ ${t.agentName}: Reset -- visszaállítva erre: ${origModel}.`)
          stopAgentProcess(t.agentName)
        }
      }

      // Usage-limit-modal wedge auto-recovery. A sticky "Stop and wait for limit
      // to reset" modal freezes the BRAIN while the MCP plugin child stays alive,
      // so the plugin-liveness loop below never sees it and the bash watchdog
      // (which only relaunches on session DEATH) never fires -- the agent sits
      // mute indefinitely. Detect it on the pane and restart the agent fresh,
      // gated by a confirm window + cooldown + restart cap (decideUsageLimitRecovery).
      // Scope boundary: the main session (marveen-channels) is owned by the
      // token-outage bridge + keepalive path, and OPUS_FALLBACK_AGENTS are owned by
      // the opus-fallback block above (which answers the same usage-limit signal
      // with a Sonnet-downgrade) -- both are excluded here so two handlers never
      // fight over the same pane. This path never model-downgrades: a transient
      // sticky 5h modal only needs a fresh session.
      if (!t.isMarveen && t.agentName && !OPUS_FALLBACK_AGENTS.includes(t.agentName)) {
        const modalDetected = pane != null && detectsUsageLimitMenu(pane)
        const prevWedge = agentUsageLimitWedge.get(t.agentName) ?? CLEAN_USAGE_LIMIT_WEDGE_STATE
        const wedgeDecision = decideUsageLimitRecovery(modalDetected, prevWedge, Date.now())
        // consecutiveModalTicks === 0 only on the cleared/no-modal reset branch.
        if (wedgeDecision.next.consecutiveModalTicks === 0) {
          agentUsageLimitWedge.delete(t.agentName)
        } else {
          agentUsageLimitWedge.set(t.agentName, wedgeDecision.next)
        }
        if (wedgeDecision.action === 'recover') {
          logger.warn({ agent: t.agentName, session: t.session, reason: wedgeDecision.reason }, 'Agent wedged on usage-limit modal -- auto-restarting fresh')
          try {
            stopAgentProcess(t.agentName)
            execSync('sleep 2', { timeout: 4000 })
            startAgentProcess(t.agentName)
            // Mark the restart so the plugin-liveness loop below and the bash
            // watchdog defer instead of double-relaunching this same tick/window.
            agentLastRestart.set(t.agentName, Date.now())
            agentDownSince.delete(t.session)
            sendAlert(`⚠️ ${t.agentName}: usage-limit modálra fagyott (élő session, fagyott agy) -- friss újraindítás. Reset után magától fut tovább.`)
          } catch (err) {
            logger.error({ err, agent: t.agentName }, 'Failed to auto-restart agent wedged on usage-limit modal')
          }
        } else if (wedgeDecision.action === 'escalate') {
          logger.error({ agent: t.agentName, session: t.session, reason: wedgeDecision.reason }, 'Agent still wedged on usage-limit modal after restart cap -- operator needed')
          sendAlert(`🚨 ${t.agentName}: usage-limit modál ${DEFAULT_USAGE_LIMIT_WEDGE_THRESHOLDS.maxRestarts} friss újraindítás után is fennáll -- valószínűleg tényleg aktív account-limit, nem elakadt modál. Kézi beavatkozás kellhet: tmux attach -t ${t.session}`)
        }
      }
    }

    for (const t of targets) {
      const claudePid = getClaudePidForSession(t.session)
      if (!claudePid) {
        if (!t.isMarveen && t.agentName) {
          const lastRestart = agentLastRestart.get(t.agentName)
          if (lastRestart && Date.now() - lastRestart < AGENT_RESTART_GRACE_MS) continue
        }
        if (t.isMarveen) {
          if (shouldEscalateMarveenDown()) handleMarveenDown()
        }
        continue
      }
      const alive = hasChannelPluginAlive(claudePid, t.provider, t.agentName)
      if (alive) {
        if (t.isMarveen) {
          handleMarveenUp()
          // Process-alive does NOT prove the inbound MCP pipe is healthy (the
          // deafness blind spot). Cross-check the keep-alive freshness.
          checkMainKeepaliveStaleness()
          // Plugin-alive + pipe-fresh STILL does not prove the agent is
          // PROCESSING. The 10h-outage blind spot: inbound queued in the
          // transcript while no assistant turn advances. Detect that and
          // recover with a context-preserving --continue respawn.
          checkMainSessionStall()
        } else if (agentDownSince.has(t.session)) {
          logger.info({ session: t.session, provider: t.provider }, 'Agent channel plugin recovered')
          agentDownSince.delete(t.session)
        }
        continue
      }
      if (t.isMarveen) {
        if (shouldEscalateMarveenDown()) handleMarveenDown()
      } else {
        if (!agentDownSince.has(t.session)) agentDownSince.set(t.session, Date.now())
        const lastRestart = agentLastRestart.get(t.agentName!)
        const restart = shouldAutoRestartDownAgent({
          processAgeMs: getProcessAgeMs(claudePid),
          msSinceLastRestart: lastRestart != null ? Date.now() - lastRestart : null,
          startupGraceMs: AGENT_STARTUP_GRACE_MS,
          restartGraceMs: AGENT_RESTART_GRACE_MS,
        })
        if (!restart) {
          logger.debug({ agent: t.agentName, provider: t.provider }, 'Channel plugin probe reports down but agent is within startup/restart grace -- deferring')
          continue
        }
        const agentProvider = resolveAgentProvider(t.agentName!)
        const stateDir = channelStateDir(agentProvider, agentDir(t.agentName!))
        const agentToken = readChannelToken(agentProvider, join(stateDir, '.env'))
        if (!agentToken) {
          logger.warn({ agent: t.agentName, provider: agentProvider }, 'Agent has no channel token in state dir -- skipping restart to avoid token conflict')
          continue
        }
        logger.warn({ agent: t.agentName, provider: t.provider }, 'Agent channel plugin down -- auto-restarting')
        try {
          stopAgentProcess(t.agentName!)
          execSync('sleep 2', { timeout: 4000 })
          startAgentProcess(t.agentName!)
          agentLastRestart.set(t.agentName!, Date.now())
          agentDownSince.delete(t.session)
        } catch (err) {
          logger.error({ err, agent: t.agentName }, 'Failed to auto-restart agent after channel plugin down')
        }
      }
    }

    // Desired-state reconciliation: bring back agents the operator wants
    // running but whose tmux session vanished entirely (shared tmux server
    // killed by a channels-unit restart, or a machine reboot). The per-target
    // loop above only handles sessions that still exist with a dead plugin.
    // Staggered to avoid the simultaneous-start race that kills agents.
    void reconcileDesiredAgents()
  }
  setTimeout(check, 30000)
  // Opus burn early-warning: check every 30 min (independent of 60s pane loop).
  // First check at startup after 5 min to let token_usage writer catch up.
  const BURN_CHECK_INTERVAL_MS = 30 * 60 * 1000
  setTimeout(() => {
    checkOpusBurnThresholds()
    setInterval(checkOpusBurnThresholds, BURN_CHECK_INTERVAL_MS)
  }, 5 * 60 * 1000)
  return setInterval(check, 60000)
}

// Start desired-but-missing agents one at a time (~15s apart). The stagger is
// mandatory: starting several channel agents at once makes them all die in the
// resume-from-summary modal race. A single in-flight burst at a time.
let reconcileBurstInProgress = false
const AGENT_RECONCILE_STAGGER_MS = 15000
function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

async function reconcileDesiredAgents(): Promise<void> {
  if (reconcileBurstInProgress) return
  const desired = getDesiredAgents()
  if (desired.size === 0) return
  const down = [...desired].filter((name) => !isAgentRunning(name))
  if (down.length === 0) return
  reconcileBurstInProgress = true
  try {
    for (const name of down) {
      if (isAgentRunning(name)) continue
      const last = agentLastRestart.get(name)
      if (last != null && Date.now() - last < AGENT_RESTART_GRACE_MS) continue
      logger.warn({ agent: name }, 'Desired agent not running -- auto-starting (reconcile)')
      try {
        const r = startAgentProcess(name)
        agentLastRestart.set(name, Date.now())
        if (!r.ok && r.error !== 'Agent is already running') {
          logger.error({ agent: name, error: r.error }, 'Reconcile start failed')
        }
      } catch (err) {
        logger.error({ err, agent: name }, 'Reconcile start threw')
      }
      await delay(AGENT_RECONCILE_STAGGER_MS)
    }
  } finally {
    reconcileBurstInProgress = false
  }
}

// Backward-compatible alias
export const startTelegramPluginMonitor = startChannelPluginMonitor
