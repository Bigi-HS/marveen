// A2 -- pre-launch preflight validator (kanban: fleet-meeting A2 quick win).
//
// Turns the agent-launch Buktatók into automated static checks that run BEFORE
// `tmux new-session`, so a misconfigured agent fails fast with a clear message
// instead of dying silently ~1-235s later (lock-death, channel restart-loop,
// missing binary, bad model id). The checks encode the hard-won failure modes
// from the 2026-06-02/03 incidents.
//
// Architecture (mirrors the rest of src/web): a PURE evaluator over a plain
// facts struct (unit-tested with no fs/exec) and a thin IO gatherer. This
// module does NOT import agent-process, so wiring runPreflight() into
// startAgentProcess introduces no import cycle.

import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { CHANNEL_PROVIDER } from '../config.js'
import { channelStateDir, readChannelToken, channelIntentFromEnabledPlugins, type ChannelProviderType } from '../channel-provider.js'
import {
  agentDir,
  readAgentModel,
  readAgentChannelProvider,
  readAgentClaudeConfigDir,
} from './agent-config.js'
import { resolveFromPath } from '../platform.js'

export type FindingLevel = 'error' | 'warn'

export interface PreflightFinding {
  code: string
  level: FindingLevel
  message: string
}

// Plain, serialisable facts about an agent's launch readiness. Gathered by IO,
// consumed by the pure evaluator.
export interface PreflightFacts {
  // Whether the agent launches with the auto-built canonical config dir
  // (agents/<name>/.claude-config). The .claude.json-copy check only applies
  // then; an operator-pinned custom config dir is left to the operator.
  usesCanonicalConfigDir: boolean
  claudeJsonExists: boolean
  claudeJsonIsSymlink: boolean
  // A channel token is present in the agent's state dir.
  hasToken: boolean
  // The channel plugin is INTENTIONALLY enabled (config-dir settings.json
  // enabledPlugins), not merely inferred from a token file.
  channelIntentEnabled: boolean
  modelId: string
  modelValid: boolean
  tmuxOnPath: boolean
  claudeOnPath: boolean
}

// A model id is valid if it is a non-empty string containing only characters
// that survive the launcher's shell quoting. The launcher single-quotes the
// model, and ids like `claude-opus-4-8[1m]` (1M-context suffix) and
// `qwen2.5:7b` (ollama tag) are legitimate, so dot, colon and brackets are
// allowed; whitespace, quotes and shell metacharacters are not.
export function isValidModelId(id: string): boolean {
  if (!id || !id.trim()) return false
  return /^[A-Za-z0-9._:[\]-]+$/.test(id)
}

// Pure: classify launch readiness into findings. 'error' findings make the
// launch unsafe (runPreflight reports not-ok); 'warn' findings are surfaced but
// do not block (the agent can still launch, just with a flagged smell).
export function evaluatePreflight(f: PreflightFacts): PreflightFinding[] {
  const out: PreflightFinding[] = []

  // Required binaries -- a missing one means the launch fails outright, so
  // catch it here with a clear message rather than as a silent tmux exit.
  if (!f.tmuxOnPath) {
    out.push({ code: 'tmux-missing', level: 'error', message: 'tmux not found on PATH; the launch would fail silently' })
  }
  if (!f.claudeOnPath) {
    out.push({ code: 'claude-missing', level: 'error', message: 'claude CLI not found on PATH; the launch would fail silently' })
  }

  // Model id must survive the launcher's shell quoting and be non-empty.
  if (!f.modelValid) {
    out.push({ code: 'model-invalid', level: 'error', message: `invalid or unresolved model id: "${f.modelId}"` })
  }

  // Isolated config dir's .claude.json MUST be a private COPY, never a symlink:
  // a symlink re-introduces the shared ~/.claude.json lock contention that
  // silently kills the freshly launched agent within ~1s (the lock-death bug).
  if (f.usesCanonicalConfigDir) {
    if (f.claudeJsonIsSymlink) {
      out.push({ code: 'claudejson-symlink', level: 'error', message: 'config-dir .claude.json is a symlink, not a private copy; shared-lock death risk (see agent-config-dir.ts)' })
    } else if (!f.claudeJsonExists) {
      out.push({ code: 'claudejson-missing', level: 'warn', message: 'config-dir .claude.json missing; it will be seeded on launch' })
    }
  }

  // Channel state must be UNAMBIGUOUS. A token present while the plugin is not
  // intentionally enabled is exactly the configuration that drove the
  // channel-monitor restart-loop (2026-06-03). Surface it loudly.
  if (f.hasToken && !f.channelIntentEnabled) {
    out.push({ code: 'channel-token-without-intent', level: 'warn', message: 'channel token present but the plugin is not enabled in settings.json; ambiguous channel state (the death-loop trigger). Remove the orphan token or enable the plugin.' })
  }
  if (!f.hasToken && f.channelIntentEnabled) {
    out.push({ code: 'channel-intent-without-token', level: 'warn', message: 'channel plugin enabled in settings.json but no token found; the channel will not connect' })
  }

  return out
}

// ---------------------------------------------------------------------------
// IO: gather the facts
// ---------------------------------------------------------------------------

function providerFor(name: string): ChannelProviderType {
  const p = readAgentChannelProvider(name)
  if (p === 'slack' || p === 'telegram' || p === 'discord') return p
  return CHANNEL_PROVIDER
}

function binOnPath(name: string): boolean {
  try { resolveFromPath(name); return true } catch { return false }
}

function lstatSafe(p: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(p) } catch { return null }
}

export function gatherPreflightFacts(name: string): PreflightFacts {
  const dir = agentDir(name)
  const canonical = join(dir, '.claude-config')
  const explicit = readAgentClaudeConfigDir(name)
  const usesCanonicalConfigDir = !explicit || explicit === canonical

  const claudeJsonPath = join(canonical, '.claude.json')
  const st = lstatSafe(claudeJsonPath)
  const claudeJsonExists = !!st
  const claudeJsonIsSymlink = !!st && st.isSymbolicLink()

  const provider = providerFor(name)
  const chanDir = channelStateDir(provider, dir)
  const hasToken = !!readChannelToken(provider, join(chanDir, '.env'))

  // Mirrors agent-process.isAgentChannelIntentionallyEnabled: the agent's LAUNCH
  // settings (<dir>/.claude/settings.json) are the source of truth for channel
  // INTENT, NOT the channel-neutral .claude-config copy (whose plugin keys are
  // stripped, so it reported false for every config-dir agent). A bare token
  // file is not intent. Shares channelIntentFromEnabledPlugins with agent-process
  // so the two cannot drift.
  let channelIntentEnabled = false
  const launchSettings = join(dir, '.claude', 'settings.json')
  if (existsSync(launchSettings)) {
    try {
      const parsed = JSON.parse(readFileSync(launchSettings, 'utf-8'))
      channelIntentEnabled = channelIntentFromEnabledPlugins(parsed?.enabledPlugins as Record<string, unknown> | undefined, provider)
    } catch {
      channelIntentEnabled = false
    }
  } else {
    // Never-launched agent: fall back to token presence, matching agent-process.
    channelIntentEnabled = hasToken
  }

  const modelId = readAgentModel(name)

  return {
    usesCanonicalConfigDir,
    claudeJsonExists,
    claudeJsonIsSymlink,
    hasToken,
    channelIntentEnabled,
    modelId,
    modelValid: isValidModelId(modelId),
    tmuxOnPath: binOnPath('tmux'),
    claudeOnPath: binOnPath('claude'),
  }
}

export interface PreflightResult {
  ok: boolean
  findings: PreflightFinding[]
  facts: PreflightFacts
}

// Run the full preflight for an agent. ok is false when any 'error' finding is
// present (the launch is unsafe); 'warn' findings never flip ok.
export function runPreflight(name: string): PreflightResult {
  const facts = gatherPreflightFacts(name)
  const findings = evaluatePreflight(facts)
  return { ok: !findings.some(x => x.level === 'error'), findings, facts }
}

// Log every finding at its level. Helper for callers (e.g. startAgentProcess)
// so the surfacing is consistent and the warn-but-launch findings are visible.
export function logPreflightFindings(name: string, result: PreflightResult): void {
  for (const f of result.findings) {
    if (f.level === 'error') logger.error({ agent: name, code: f.code }, `preflight: ${f.message}`)
    else logger.warn({ agent: name, code: f.code }, `preflight: ${f.message}`)
  }
}

// One-line human summary of the error findings, for the launch error message.
export function summarizePreflightErrors(result: PreflightResult): string {
  return result.findings
    .filter(f => f.level === 'error')
    .map(f => `${f.code}: ${f.message}`)
    .join('; ')
}
