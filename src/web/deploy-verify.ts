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
import { getDb } from '../db.js'
import { listAgentNames, readAgentChannelProviderSafe } from './agent-config.js'
import {
  isTmuxSessionAlive,
  isAgentChannelIntentionallyEnabled,
  agentHasChannel,
  agentSessionName,
} from './agent-process.js'
import { MAIN_AGENT_ID } from '../config.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { channelEnvVaultId } from './channel-token-durability.js'
import { getSecret } from './vault.js'

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

  // Main orchestrator sessions.
  for (const s of [MAIN_AGENT_ID, MAIN_CHANNELS_SESSION]) {
    if (!deps.isSessionAlive(s)) missing.push(`session:${s}`)
  }

  // Agent sessions.
  for (const name of deps.listAgents()) {
    if (!deps.isSessionAlive(agentSessionName(name))) missing.push(`session:agent-${name}`)
  }

  // Key watchdog processes.
  for (const pattern of WATCHDOG_PATTERNS) {
    if (!deps.isPgrepMatch(pattern)) missing.push(`watchdog:${pattern.split('/').pop()?.split(' ')[0] ?? pattern}`)
  }

  const pass = missing.length === 0
  return {
    pass,
    label: 'Sessions + watchdogs',
    detail: pass ? 'All sessions alive; all watchdogs running' : `Missing: ${missing.join(', ')}`,
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
  const checks = {
    F1: checkF1(deps),
    F2: checkF2(deps),
    F3: checkF3(deps),
    F4: checkF4(deps),
  }
  const score = Object.values(checks).filter(c => c.pass).length
  return { pass: score === 4, score, total: 4, checks }
}
