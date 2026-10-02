// 4-point fleet deploy-verify -- mechanically asserts fleet health post-deploy.
//
// F1 -- server up:   DB is accessible (if the route is reachable, HTTP is up;
//                    we additionally probe the DB so a wedged DB doesn't
//                    silently pass).
// F2 -- sessions + watchdogs:
//                    key tmux sessions alive (marveen, marveen-channels, all
//                    agent-<name>) + key watchdog processes running (pgrep).
// F3 -- channel-recovery intent:
//                    every channel-enabled agent has intentionallyEnabled=true;
//                    never "configured but disabled" (death-loop source).
// F4 -- token vault-restore:
//                    every channel agent has a non-null vault backup for its
//                    channel .env (restore mechanism works).
//
// Injectable deps so unit tests run without tmux/pgrep/DB.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db.js'
import { listAgentNames, readAgentChannelProviderSafe } from './agent-config.js'
import {
  isTmuxSessionAlive,
  isAgentChannelIntentionallyEnabled,
  agentHasChannel,
  agentSessionName,
} from './agent-process.js'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR } from '../config.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { channelEnvVaultId } from './channel-token-durability.js'
import { getSecret } from './vault.js'

// Mirror of sleep-guard.sh SG_BOOT_LEAD_SECONDS: a scheduled task due within this
// many seconds is a wake-obligation (so a sleeper is launched ahead of it).
const SLEEP_BOOT_LEAD_SECONDS = 150

export interface VerifyCheck {
  pass: boolean
  label: string
  detail: string
}

export interface DeployVerifyResult {
  pass: boolean
  score: number
  total: number
  checks: Record<string, VerifyCheck>
}

export interface DeployVerifyDeps {
  isSessionAlive: (name: string) => boolean
  isPgrepMatch: (pattern: string) => boolean
  listAgents: () => string[]
  hasChannel: (name: string) => boolean
  isChannelIntentional: (name: string) => boolean
  getChannelProvider: (name: string) => string | null
  getVaultSecret: (id: string) => string | null
  isDbAccessible: () => boolean
  // Sleep-mode awareness (card 0c6f8263). A sleep-eligible agent (AGENT-a2b05be5)
  // intentionally has no tmux session while asleep -- it is NOT down unless it
  // owes work (a wake-obligation) while still having no session.
  isSleepModeEnabled: () => boolean
  getSleepEligible: () => string[]
  isSleepWatchdogRunning: (name: string) => boolean
  hasWakeObligation: (name: string) => boolean
}

// Key watchdog pgrep patterns -- checked as a minimum baseline.
// Kept short; each pattern should be UNIQUE enough to not collide with other processes.
const WATCHDOG_PATTERNS = [
  'scripts/fleet-supervisor.sh',
  'scripts/dave-watchdog.sh',
  'channel-watchdog.sh --loop',
]

function pgrepMatch(pattern: string): boolean {
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function dbAccessible(): boolean {
  try {
    getDb().prepare('SELECT 1').get()
    return true
  } catch {
    return false
  }
}

// Sleep-mode is active when the fleet-wide flag file is present.
function sleepModeEnabled(): boolean {
  return existsSync(join(STORE_DIR, 'agent-sleep-mode.enabled'))
}

// Sleep-eligible roster: an operator override (store/sleep-eligible.txt) takes
// precedence over the shipped default (scripts/sleep-eligible.default.txt).
// One id per line; '#' comments and blank lines ignored.
function readSleepEligible(): string[] {
  const override = join(STORE_DIR, 'sleep-eligible.txt')
  const dflt = join(PROJECT_ROOT, 'scripts', 'sleep-eligible.default.txt')
  const path = existsSync(override) ? override : dflt
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
  } catch {
    return []
  }
}

// The on-demand sleep watchdog (scripts/sleep-agent-watchdog.sh <name>) is what
// wakes a sleeper on a real trigger. Its presence proves managed sleep.
function sleepWatchdogRunning(name: string): boolean {
  return pgrepMatch(`sleep-agent-watchdog.sh ${name}`)
}

// Mirror of sleep-guard.sh sg_should_wake: an asleep agent owes work iff it has
// an undelivered inter-agent message, an in_progress card, or a scheduled task
// due within the boot-lead window.
function hasWakeObligation(name: string): boolean {
  try {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    const msg = db
      .prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent=? AND delivered_at IS NULL')
      .get(name) as { n: number }
    if (msg.n > 0) return true
    const card = db
      .prepare("SELECT COUNT(*) AS n FROM kanban_cards WHERE assignee=? AND status='in_progress'")
      .get(name) as { n: number }
    if (card.n > 0) return true
    const task = db
      .prepare("SELECT COUNT(*) AS n FROM scheduled_tasks WHERE agent=? AND status='active' AND next_run<=?")
      .get(name, now + SLEEP_BOOT_LEAD_SECONDS) as { n: number }
    if (task.n > 0) return true
    return false
  } catch {
    return false
  }
}

const realDeps: DeployVerifyDeps = {
  isSessionAlive: isTmuxSessionAlive,
  isPgrepMatch: pgrepMatch,
  listAgents: listAgentNames,
  hasChannel: agentHasChannel,
  isChannelIntentional: isAgentChannelIntentionallyEnabled,
  getChannelProvider: (name) => {
    const r = readAgentChannelProviderSafe(name)
    return r.provider ?? null
  },
  getVaultSecret: getSecret,
  isDbAccessible: dbAccessible,
  isSleepModeEnabled: sleepModeEnabled,
  getSleepEligible: readSleepEligible,
  isSleepWatchdogRunning: sleepWatchdogRunning,
  hasWakeObligation: hasWakeObligation,
}

// Seam for tests.
let _deps: DeployVerifyDeps = realDeps
export function __setDeployVerifyDeps(d: Partial<DeployVerifyDeps>): void {
  _deps = { ...realDeps, ...d }
}
export function __resetDeployVerifyDeps(): void {
  _deps = realDeps
}

// F1 -- server + DB up.
function checkF1(deps: DeployVerifyDeps): VerifyCheck {
  const ok = deps.isDbAccessible()
  return {
    pass: ok,
    label: 'Server + DB up',
    detail: ok ? 'HTTP route reached; DB SELECT 1 OK' : 'DB not accessible',
  }
}

// F2 -- sessions + watchdogs.
function checkF2(deps: DeployVerifyDeps): VerifyCheck {
  const missing: string[] = []
  const asleep: string[] = []

  // Main orchestrator sessions.
  for (const s of [MAIN_AGENT_ID, MAIN_CHANNELS_SESSION]) {
    if (!deps.isSessionAlive(s)) missing.push(`session:${s}`)
  }

  // Sleep-mode aware agent sessions (card 0c6f8263). When sleep-mode is on, a
  // session-less agent on the eligible roster is a VALID (asleep) state, not a
  // down -- unless it owes work, or nothing is watching to wake it.
  const sleepModeOn = deps.isSleepModeEnabled()
  const eligible = sleepModeOn ? new Set(deps.getSleepEligible()) : new Set<string>()
  for (const name of deps.listAgents()) {
    if (deps.isSessionAlive(agentSessionName(name))) continue
    if (eligible.has(name)) {
      if (deps.hasWakeObligation(name)) {
        // Should be awake (unmet wake-obligation) but has no session -> down.
        missing.push(`asleep-with-obligation:${name}`)
      } else if (!deps.isSleepWatchdogRunning(name)) {
        // Idle with no obligation, but no sleep watchdog -> nothing will wake it.
        missing.push(`sleep-unmanaged:${name}`)
      } else {
        // Correctly asleep + managed + no obligation -> OK.
        asleep.push(name)
      }
      continue
    }
    missing.push(`session:agent-${name}`)
  }

  // Key watchdog processes.
  for (const pattern of WATCHDOG_PATTERNS) {
    if (!deps.isPgrepMatch(pattern)) missing.push(`watchdog:${pattern.split('/').pop()?.split(' ')[0] ?? pattern}`)
  }

  const pass = missing.length === 0
  const asleepNote = asleep.length > 0 ? ` (${asleep.length} asleep/managed: ${asleep.join(', ')})` : ''
  return {
    pass,
    label: 'Sessions + watchdogs',
    detail: pass
      ? `All sessions alive; all watchdogs running${asleepNote}`
      : `Missing: ${missing.join(', ')}${asleepNote}`,
  }
}

// F3 -- channel-recovery intent (never "configured but disabled").
function checkF3(deps: DeployVerifyDeps): VerifyCheck {
  const broken: string[] = []
  for (const name of deps.listAgents()) {
    if (!deps.hasChannel(name)) continue
    if (!deps.isChannelIntentional(name)) broken.push(name)
  }
  const pass = broken.length === 0
  return {
    pass,
    label: 'Channel-recovery intent',
    detail: pass
      ? 'All channel agents intentionallyEnabled=true'
      : `Broken (configured but disabled): ${broken.join(', ')}`,
  }
}

// F4 -- token vault-restore mechanism.
function checkF4(deps: DeployVerifyDeps): VerifyCheck {
  const missing: string[] = []
  for (const name of deps.listAgents()) {
    if (!deps.hasChannel(name)) continue
    const provider = deps.getChannelProvider(name)
    if (!provider) continue
    const vaultId = channelEnvVaultId(name, provider as 'telegram' | 'slack' | 'discord')
    if (!deps.getVaultSecret(vaultId)) missing.push(`${name}/${provider}`)
  }
  const pass = missing.length === 0
  return {
    pass,
    label: 'Token vault-restore',
    detail: pass
      ? 'All channel agents have vault backup'
      : `Missing vault backup: ${missing.join(', ')}`,
  }
}

export function runDeployVerify(deps: DeployVerifyDeps = _deps): DeployVerifyResult {
  // *-local agents are dev-only clones that never run as production tmux sessions.
  // Strip them before any check so their absence does not false-fail F2/F3/F4.
  const prodDeps: DeployVerifyDeps = {
    ...deps,
    listAgents: () => deps.listAgents().filter(n => !n.endsWith('-local')),
  }
  const checks = {
    F1: checkF1(prodDeps),
    F2: checkF2(prodDeps),
    F3: checkF3(prodDeps),
    F4: checkF4(prodDeps),
  }
  const score = Object.values(checks).filter(c => c.pass).length
  return { pass: score === 4, score, total: 4, checks }
}
