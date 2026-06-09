// Reap orphaned channel-plugin pollers (bun/node processes that survived a
// tmux kill-session or are left over from a previous agent crash).
//
// The bug we close (2026-06-01 incident, channel-disconnect roundtrip):
//   - stopAgentProcess used `pkill -f TELEGRAM_STATE_DIR=<dir>`, but the
//     plugin process argv is just `bun run --cwd .../telegram/0.0.6 start`
//     - the env var lives in /proc-equivalent environment storage, not argv,
//     so `pkill -f` never matches and the orphan keeps polling getUpdates
//     with the same bot token until SIGTERM by hand.
//   - startAgentProcess only killed the tmux session pre-launch and did NOT
//     reap orphans at all. After a restart the old poller raced the new one
//     and Telegram returned 409 Conflict in a loop.
//   - The plugin writes bot.pid in <chanDir>/bot.pid. That works on the
//     happy path but if a new poller crashed and a later one overwrote the
//     file, the older orphan is no longer in bot.pid - we miss it.
//
// Strategy: combine two identifiers.
//   1. bot.pid (cheap, works for the supervised process).
//   2. `ps eww -e` scan for the *_STATE_DIR=<chanDir> env-var match. This
//      catches orphans whose pid is no longer in bot.pid - any process that
//      was started against this channel state dir is in scope, regardless
//      of how its argv was rendered. macOS BSD ps emits each process's full
//      environment when invoked with `e`; we grep that.

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelProviderType } from '../channel-provider.js'
import { channelStateDir } from '../channel-provider.js'
import { logger } from '../logger.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'

const STATE_ENV_VAR: Record<ChannelProviderType, string> = {
  telegram: 'TELEGRAM_STATE_DIR',
  slack: 'SLACK_STATE_DIR',
  discord: 'DISCORD_STATE_DIR',
}

// Parse `ps eww -e` output and return every PID whose process environment
// contains `<envVar>=<value>`. Exported for testability.
//
// `ps eww -e` rows on macOS look like:
//   90798 s000  S+   0:00.01 bun run --cwd ... HOME=/Users/... TELEGRAM_STATE_DIR=/path... ...
// The match must be precise: substring `TELEGRAM_STATE_DIR=/path` against
// `TELEGRAM_STATE_DIR=/path-elsewhere` is acceptable because the value is an
// absolute path, but we still anchor on the env-var literal to avoid
// matching a row that just *mentions* the path string in its argv.
export function parsePollerPidsFromPs(
  psOutput: string,
  envVar: string,
  value: string,
): number[] {
  const needle = `${envVar}=${value}`
  const out: number[] = []
  for (const line of psOutput.split('\n')) {
    const idx = line.indexOf(needle)
    if (idx === -1) continue
    // Exact-match guard (P9-F3): the value must be terminated by whitespace or
    // end-of-line, not more path chars. The `ps eww -e` env dump is space-
    // separated, so `<ENV>=/x/telegram` must NOT match a row carrying
    // `<ENV>=/x/telegram-extra` (a bare includes() substring would false-positive).
    const after = line[idx + needle.length]
    if (after !== undefined && !/\s/.test(after)) continue
    const m = line.match(/^\s*(\d+)\s/)
    if (!m) continue
    const pid = parseInt(m[1]!, 10)
    if (pid > 1) out.push(pid)
  }
  return out
}

// A single `ps eww -e` snapshot, shareable across many per-agent presence probes
// within one monitor tick (P9-F2). `ok=false` means the scan itself failed, so
// callers must fail-safe (presence -> null) instead of reading the empty output.
export interface ProcEnvScan {
  ok: boolean
  output: string
}

// Take one `ps eww -e` snapshot. Call once per tick and pass the result into
// every probeChannelPollerPresence so a tick forks `ps` ONCE, not per agent.
export function captureProcEnvScan(): ProcEnvScan {
  try {
    const output = execSync('/bin/ps eww -e', { timeout: 5000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
    return { ok: true, output }
  } catch (err) {
    logger.warn({ err }, 'channel-poller-reap: presence ps scan failed')
    return { ok: false, output: '' }
  }
}

function listPollerPidsByStateDir(envVar: string, chanDir: string): number[] {
  try {
    const out = execSync('/bin/ps eww -e', { timeout: 5000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
    return parsePollerPidsFromPs(out, envVar, chanDir)
  } catch (err) {
    logger.warn({ err, chanDir }, 'channel-poller-reap: ps scan failed')
    return []
  }
}

function readBotPid(chanDir: string): number | null {
  const path = join(chanDir, 'bot.pid')
  if (!existsSync(path)) return null
  try {
    const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10)
    return Number.isFinite(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

// process.kill(pid, 0) probes existence without signalling. ESRCH -> gone;
// EPERM -> exists but owned by another user (still alive). Our pollers are
// same-user, but treat EPERM as alive to stay on the safe (present) side.
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Is there a LIVE channel poller for this agent's channel? The inverse of the
 * reap question, used by the channel-health monitor to catch an MCP child that
 * was killed EXTERNALLY (a dashboard deploy-restart or OS-sleep) -- a case the
 * pane ✘-marker never renders, so the pane-based detector misses it.
 *
 * Two independent signals, both liveness-checked: the supervised bot.pid and
 * the `ps eww -e` env-var scan (catches a poller whose bot.pid went stale).
 * Returns:
 *   true   -- at least one signal found a live poller
 *   false  -- the ps scan SUCCEEDED and both signals are clean (definitively absent)
 *   null   -- could not determine (ps scan failed and no live bot.pid): fail-safe,
 *             callers must NOT act on null (avoids a false reconnect on the live agent)
 *
 * `agentDirPath` is the agent dir for a sub-agent, or undefined for the main
 * agent (whose channel state lives under ~/.claude/channels).
 *
 * `psScan` (P9-F2) lets a per-tick caller share ONE `ps eww -e` across every
 * agent it probes instead of forking a `ps` per agent: pass the captured scan
 * (see captureProcEnvScan) and it is sliced for this agent's state dir. When
 * omitted, a fresh `ps eww -e` is taken (the standalone / single-probe path).
 */
export function probeChannelPollerPresence(
  provider: ChannelProviderType,
  agentDirPath?: string,
  psScan?: ProcEnvScan,
): boolean | null {
  const chanDir = channelStateDir(provider, agentDirPath)
  const botPid = readBotPid(chanDir)
  if (botPid != null && isPidAlive(botPid)) return true
  const scan = psScan ?? captureProcEnvScan()
  const pids = scan.ok
    ? parsePollerPidsFromPs(scan.output, STATE_ENV_VAR[provider], chanDir)
    : []
  if (pids.some(isPidAlive)) return true
  return scan.ok ? false : null
}

export interface ReapResult {
  reaped: number[]
  source: { fromBotPid: number | null; fromEnvScan: number[] }
}

/**
 * Reap every channel-plugin poller process associated with this agent.
 * Combines bot.pid (cheap, supervised pid) with a `ps eww -e` env-var scan
 * (catches orphans whose pid is no longer in bot.pid). SIGTERM first; after
 * a short grace period, SIGKILL any survivor. Safe to call multiple times
 * (process.kill on a missing pid is caught).
 */
export function reapChannelOrphans(
  provider: ChannelProviderType,
  agentDirPath: string,
): ReapResult {
  const chanDir = channelStateDir(provider, agentDirPath)
  const envVar = STATE_ENV_VAR[provider]

  const fromBotPid = readBotPid(chanDir)
  const fromEnvScan = listPollerPidsByStateDir(envVar, chanDir)

  // Deduplicate while preserving order so the bot.pid path is logged first.
  const all: number[] = []
  const seen = new Set<number>()
  for (const pid of [fromBotPid, ...fromEnvScan]) {
    if (pid && !seen.has(pid)) {
      seen.add(pid)
      all.push(pid)
    }
  }

  // SIGTERM, give bun/node ~300ms to flush, then SIGKILL stragglers.
  for (const pid of all) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
  if (all.length > 0) {
    try { execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 }) } catch { /* ignore */ }
    for (const pid of all) {
      try { process.kill(pid, 0) /* probe */; process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
  }

  if (all.length > 0) {
    logger.info({ provider, chanDir, reaped: all, fromBotPid, fromEnvScan }, 'channel-poller-reap: orphans killed')
  }
  return { reaped: all, source: { fromBotPid, fromEnvScan } }
}

// ---------------------------------------------------------------------------
// Detached channel CLAUDE reaper (the parent-process leak, 2026-06-03).
//
// reapChannelOrphans (above) kills bun/node POLLERS by env-var scan + bot.pid.
// That works for sub-agents (their claude+poller carry TELEGRAM_STATE_DIR=<dir>)
// but MISSES the main channels session entirely: channels.sh launches the main
// `claude --channels` with NO *_STATE_DIR export (the plugin uses its default
// dir), so neither the main claude nor its poller match the env needle, and the
// plugin never writes bot.pid. When a --continue respawn (channel-monitor
// respawn-pane / agent-process start) fails to tear down the prior claude, the
// detached claude survives -- reparented to the tmux server -- and keeps a bun
// poller hitting getUpdates on the SHARED bot token. 5 such orphans accumulated
// over 13 days, each 409-racing the live poller (token churn + a self-feeding
// agent thrash-restart loop). See project_channels_continue_respawn_leak.
//
// Identification is by tmux-pane attribution, NOT env/argv heuristics (cmdline
// alone cannot tell a live agent claude from a detached one -- see
// feedback_verify_session_before_kill): a `claude --channels` process is an
// orphan iff neither its pid nor any ancestor pid is a LIVE tmux pane pid.
//   - main session: tmux runs claude as the pane leader, so claudePid == panePid.
//   - sub-agents:   tmux runs `sh -c "...claude..."`, so the pane pid is the sh
//                   and claude is its child -> ancestor walk catches it.
// The tmux SERVER process is excluded up front: its argv embeds the full
// `new-session ... claude --channels ...` string, a false positive, but argv[0]
// is tmux, not claude.

export interface ProcRow { pid: number; ppid: number; command: string }

// argv[0] basename === 'claude' (the binary), so the tmux server row whose argv
// merely *contains* the claude command string is excluded.
function isClaudeBinary(command: string): boolean {
  const argv0 = command.trim().split(/\s+/, 1)[0] ?? ''
  const base = argv0.split('/').pop() ?? ''
  return base === 'claude'
}

/**
 * Pure: return the pids of `claude --channels` processes that are NOT attached
 * to any live tmux pane (orphans). `livePanePids` is the set of pane pids from
 * `tmux list-panes -a`. `channelNeedle` optionally restricts to one plugin
 * (e.g. 'plugin:telegram@...'); when omitted, every channel plugin is in scope.
 * Exported for testability.
 */
export function findOrphanChannelClaudes(
  procs: ProcRow[],
  livePanePids: Set<number>,
  channelNeedle?: string,
): number[] {
  const byPid = new Map<number, ProcRow>()
  for (const p of procs) byPid.set(p.pid, p)

  const attachedToLivePane = (pid: number): boolean => {
    let cur = pid
    const seen = new Set<number>()
    for (let hops = 0; hops < 8; hops++) {
      if (livePanePids.has(cur)) return true
      if (seen.has(cur)) break
      seen.add(cur)
      const next = byPid.get(cur)?.ppid
      if (next === undefined || next === cur || next <= 1) break
      cur = next
    }
    return false
  }

  const orphans: number[] = []
  for (const p of procs) {
    if (!p.command.includes('--channels')) continue
    if (!isClaudeBinary(p.command)) continue
    if (channelNeedle && !p.command.includes(channelNeedle)) continue
    if (attachedToLivePane(p.pid)) continue
    orphans.push(p.pid)
  }
  return orphans
}

function snapshotProcs(): ProcRow[] {
  try {
    const out = execSync('/bin/ps -axww -o pid=,ppid=,command=', { timeout: 5000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
    const rows: ProcRow[] = []
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
      if (!m) continue
      rows.push({ pid: parseInt(m[1]!, 10), ppid: parseInt(m[2]!, 10), command: m[3]! })
    }
    return rows
  } catch (err) {
    logger.warn({ err }, 'channel-poller-reap: ps -axww snapshot failed')
    return []
  }
}

// Resolve live tmux pane pids. `session` undefined -> all sessions (`-a`);
// otherwise just that one session. Returns null when the tmux query FAILS (so
// the caller can fail-closed) vs an empty/Set on a clean result. A missing
// session (`-t <gone>`) exits non-zero -> null too, which the caller treats as
// "no panes from this source", never as a reason to widen the kill set.
function livePanePids(tmuxPath: string, session?: string): Set<number> | null {
  const target = session ? ['-t', session] : ['-a']
  try {
    const out = execFileSync(tmuxPath, ['list-panes', ...target, '-F', '#{pane_pid}'], { timeout: 5000, encoding: 'utf-8' })
    const s = new Set<number>()
    for (const line of out.split('\n')) {
      const n = parseInt(line.trim(), 10)
      if (Number.isFinite(n) && n > 1) s.add(n)
    }
    return s
  } catch (err) {
    logger.warn({ err, session: session ?? '(all)' }, 'channel-poller-reap: tmux list-panes failed')
    return null
  }
}

export interface DetachedReapDecision {
  reap: number[]
  skipped: boolean
  reason?: 'global-query-failed' | 'no-live-panes'
}

/**
 * PURE reap decision. Fail-CLOSED: if the global `list-panes -a` query failed
 * (`globalPanePids === null`) or resolved zero panes, we cannot tell an orphan
 * from the live orchestrator, so we reap NOTHING.
 *
 * Redundant orchestrator protection: the main channels session's panes
 * (`mainSessionPanePids`, an independent `list-panes -t` query) are UNIONed into
 * the protected set. So even a PARTIAL `-a` result that happened to omit the
 * orchestrator's pane cannot mark it an orphan -- the kill set can never reach
 * the live orchestrator worker (card bcf10d21). A null/empty main-session set
 * only adds nothing; it never widens the kill set.
 */
export function decideDetachedClaudeReap(input: {
  procs: ProcRow[]
  globalPanePids: Set<number> | null
  mainSessionPanePids: Set<number> | null
  channelNeedle?: string
}): DetachedReapDecision {
  const { procs, globalPanePids, mainSessionPanePids, channelNeedle } = input
  if (globalPanePids === null) return { reap: [], skipped: true, reason: 'global-query-failed' }
  if (globalPanePids.size === 0) return { reap: [], skipped: true, reason: 'no-live-panes' }
  const protectedPids = new Set(globalPanePids)
  if (mainSessionPanePids) for (const p of mainSessionPanePids) protectedPids.add(p)
  return { reap: findOrphanChannelClaudes(procs, protectedPids, channelNeedle), skipped: false }
}

function killBunChildren(claudePid: number): void {
  try {
    const out = execSync(`/usr/bin/pgrep -P ${claudePid} bun`, { timeout: 3000, encoding: 'utf-8' })
    for (const line of out.split('\n')) {
      const pid = parseInt(line.trim(), 10)
      if (Number.isFinite(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
      }
    }
  } catch { /* no bun children (pgrep exits 1) */ }
}

/**
 * Reap detached `claude --channels` orphans (parent-process leak). SAFE to call
 * before any (re)spawn: it spares every claude attached to a live tmux pane, so
 * it never kills the active session or a live sibling agent -- only truly
 * detached leftovers. Kills each orphan's bun poller children first, then the
 * claude (SIGTERM, ~300ms grace, SIGKILL stragglers). Returns reaped pids.
 *
 * tmuxPath defaults to a bare `tmux` (resolved on PATH); callers that already
 * hold an absolute path should pass it.
 */
export function reapDetachedChannelClaudes(opts: { channelNeedle?: string; tmuxPath?: string } = {}): number[] {
  const tmuxPath = opts.tmuxPath ?? 'tmux'
  const procs = snapshotProcs()
  // Two independent tmux queries: the global pane set (primary attribution) and
  // the main channels session's panes (redundant orchestrator protection).
  const decision = decideDetachedClaudeReap({
    procs,
    globalPanePids: livePanePids(tmuxPath),
    mainSessionPanePids: livePanePids(tmuxPath, MAIN_CHANNELS_SESSION),
    channelNeedle: opts.channelNeedle,
  })
  if (decision.skipped) {
    logger.warn({ reason: decision.reason }, 'channel-poller-reap: skipping detached-claude reap (fail-closed: cannot attribute panes)')
    return []
  }
  const orphans = decision.reap
  for (const pid of orphans) {
    killBunChildren(pid)
    try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
  }
  if (orphans.length > 0) {
    try { execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 }) } catch { /* ignore */ }
    for (const pid of orphans) {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
    logger.info({ reaped: orphans, channelNeedle: opts.channelNeedle ?? '(all)' }, 'channel-poller-reap: detached channel claudes killed')
  }
  return orphans
}
