import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { safeJoin } from './sanitize.js'

export const AGENTS_BASE_DIR = join(PROJECT_ROOT, 'agents')

export const DEFAULT_MODEL = 'claude-sonnet-4-6'

// Map short model names to full Claude model IDs (backwards compat with old configs)
export const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-4-8[1m]',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5-20251001',
  'inherit': DEFAULT_MODEL,
}

// Archetype -> default model policy (token/cost right-sizing). The idea: an
// agent's WORKLOAD class picks a sensibly-sized model so the fleet does not run
// everything on opus (the main cost driver). Values are MODEL_ALIASES keys,
// resolved to full ids by modelForArchetype.
//   - light background work (heartbeat / monitor / canary) -> haiku
//   - conversational / orchestration -> sonnet
//   - engineering / architecture / debugging (deep reasoning) -> opus
// This is a DEFAULT only: an explicit `model` field in agent-config always wins
// (see resolveAgentModelFromConfig), so adding the field changes no existing
// agent until its `model` override is removed in favour of an `archetype`.
export const ARCHETYPE_MODEL: Record<string, string> = {
  heartbeat: 'haiku',
  monitor: 'haiku',
  canary: 'haiku',
  chat: 'sonnet',
  assistant: 'sonnet',
  orchestrator: 'sonnet',
  engineer: 'opus',
  architect: 'opus',
  debug: 'opus',
}

// Resolve an archetype to its policy model id, or null when the archetype is
// missing/unknown (caller falls back to the explicit model or DEFAULT_MODEL).
export function modelForArchetype(archetype: string | null | undefined): string | null {
  if (!archetype || typeof archetype !== 'string') return null
  const alias = ARCHETYPE_MODEL[archetype.trim().toLowerCase()]
  return alias ? resolveModelId(alias) : null
}

// Pure model-resolution precedence, unit-testable without the filesystem:
//   1. explicit `model` (alias-resolved) -- backward compatible, always wins
//   2. `archetype` policy default
//   3. DEFAULT_MODEL
export function resolveAgentModelFromConfig(config: { model?: unknown; archetype?: unknown }): string {
  const explicit = typeof config.model === 'string' && config.model.trim()
    ? resolveModelId(config.model)
    : null
  if (explicit) return explicit
  const fromArchetype = modelForArchetype(typeof config.archetype === 'string' ? config.archetype : null)
  return fromArchetype || DEFAULT_MODEL
}

export function agentDir(name: string): string {
  // safeJoin rejects path-traversal components. The first line of defense is
  // still sanitizeAgentName() at the create-endpoint, but going through
  // safeJoin turns every non-whitelisted `name` (e.g. a buggy internal caller
  // that forgot to sanitize) into an explicit throw instead of silently
  // writing outside AGENTS_BASE_DIR.
  return safeJoin(AGENTS_BASE_DIR, name)
}

export function agentConfigRoot(name: string): string {
  if (name === MAIN_AGENT_ID) return PROJECT_ROOT
  return agentDir(name)
}

export function readFileOr(path: string, fallback: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return fallback }
}

export function extractDescriptionFromClaudeMd(content: string): string {
  // Try to grab first meaningful paragraph after any heading
  const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  return lines[0]?.trim().slice(0, 200) || ''
}

export function findAvatarForAgent(name: string): string | null {
  const dir = agentDir(name)
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const p = join(dir, `avatar${ext}`)
    if (existsSync(p)) return p
  }
  return null
}

export function resolveModelId(raw: string): string {
  return MODEL_ALIASES[raw] || raw
}

// Per-model context window (in tokens). Used to size the proactive /compact
// threshold per archetype: a Sonnet/Haiku agent (200K window) must compact far
// earlier than a 1M-context Opus agent, so a single fixed token threshold is
// wrong for everyone but one model. Keys are full model ids (alias-resolved).
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-8[1m]': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
}

// Default context window for any model id we don't explicitly know. 200K is the
// standard Claude window and the safe (smaller) assumption: it makes us compact
// earlier rather than risk running a large session past its real limit.
export const DEFAULT_CONTEXT_WINDOW = 200_000

// Resolve a model id (alias or full) to its context window in tokens. Strips the
// alias indirection first so 'opus'/'sonnet'/'haiku' resolve too. Falls back to
// DEFAULT_CONTEXT_WINDOW for unknown ids (and for a null/empty input).
export function contextWindowForModel(modelId: string | null | undefined): number {
  if (!modelId || typeof modelId !== 'string') return DEFAULT_CONTEXT_WINDOW
  const resolved = resolveModelId(modelId.trim())
  return MODEL_CONTEXT_WINDOWS[resolved] ?? DEFAULT_CONTEXT_WINDOW
}

// Turn a raw context-token count into a percentage of the model's window,
// rounded to a whole percent and clamped to [0, 100]. Shared by the dashboard
// (per-agent badge) and the context-window watchdog so both report the same
// number from the same window mapping.
export function contextPercentForModel(tokens: number, modelId: string | null | undefined): number {
  const window = contextWindowForModel(modelId)
  if (!(window > 0) || !(tokens > 0)) return 0
  return Math.max(0, Math.min(100, Math.round((tokens / window) * 100)))
}

export function readAgentModel(name: string): string {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    return resolveAgentModelFromConfig(config)
  } catch {
    return DEFAULT_MODEL
  }
}

// Pure: normalise an archetype input to canonical form (trimmed, lowercased), or
// null when empty/blank/non-string (which clears the override). Shared by the
// reader and writer so they cannot drift.
export function normalizeArchetypeInput(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null
}

// The agent's archetype (workload class), or null when unset. Drives the model
// right-sizing default (ARCHETYPE_MODEL) and is surfaced on the dashboard.
export function readAgentArchetype(name: string): string | null {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    return normalizeArchetypeInput(JSON.parse(readFileOr(configPath, '{}')).archetype)
  } catch {
    return null
  }
}

// Set (or clear) the agent's archetype. An empty/blank value removes the override
// so model resolution falls back to the explicit model / DEFAULT_MODEL.
export function writeAgentArchetype(name: string, archetype: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  const a = normalizeArchetypeInput(archetype)
  if (a) config.archetype = a
  else delete config.archetype
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function writeAgentModel(name: string, model: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.model = model
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function readAgentDisplayName(name: string): string {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    const raw = typeof config.displayName === 'string' ? config.displayName.trim() : ''
    if (raw) return raw
  } catch { /* fall through */ }
  // Fall back to a title-cased version of the sanitized name.
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function writeAgentDisplayName(name: string, displayName: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.displayName = displayName
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

// Pure: resolve the optional per-agent `ackCapable` flag (card 0978279f).
// FAIL-CLOSED -- a recipient is ACK-capable only when its config explicitly opts
// in with the boolean `true` (or the string "true", case-insensitive, for a
// hand-edit / dashboard form). Anything else (absent, false, a number, a typo,
// null) -> not capable. This is the no-cry-wolf gate: an ack_expected message to
// a non-capable recipient writes no pending-ack, so a misconfigured value can
// never cause a 15-min false escalation -- the worst case is the protocol stays
// inert and the d37df625 1h-abandonment net backstops the message.
export function resolveAckCapableFromConfig(config: { ackCapable?: unknown }): boolean {
  const v = config.ackCapable
  if (v === true) return true
  if (typeof v === 'string' && v.trim().toLowerCase() === 'true') return true
  return false
}

// The recipient's ACK-capability, read FRESH from agent-config.json on every
// call (no module cache) so a live flag edit takes effect at router time, not at
// boot (card 0978279f, live-config requirement). Default false (fail-closed) on
// a missing file / parse error / absent flag. Mirrors the other readers' fresh
// readFileOr + try/catch shape.
export function readAgentAckCapable(name: string): boolean {
  // The main agent (orchestrator) is ALWAYS ACK-capable, decided in CODE with no
  // agent-config.json -- it is the central delegation hub and the clear-observer
  // already special-cases its pane (MAIN_AGENT_ID -> MAIN_CHANNELS_SESSION), so
  // engagement-clear works for it. Done in code on purpose: the bash watchdog
  // read_model() reads only `model`, so a model-less agents/<main>/agent-config.json
  // would relaunch the main agent on the sonnet default at the next restart
  // (card ff96810c). Mirrors the agentDir()/isKnownAgent() MAIN_AGENT_ID cases.
  if (name === MAIN_AGENT_ID) return true
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    return resolveAckCapableFromConfig(JSON.parse(readFileOr(configPath, '{}')))
  } catch {
    return false
  }
}

export function readAgentSecurityProfile(name: string): string {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    if (typeof config.securityProfile === 'string' && config.securityProfile.trim()) {
      return config.securityProfile.trim()
    }
  } catch { /* fall through */ }
  return 'default'
}

// Pure-logic resolver for the optional per-agent claudeConfigDir field.
// Takes the raw agent-config.json text (or `{}` when no file exists) plus an
// explicit home-dir, and returns the absolute path to use as
// CLAUDE_CONFIG_DIR, or null when the field is missing/blank/non-string or
// the JSON is unparseable. Tilde forms are expanded against the supplied
// homeDir. Kept dependency-free so it can be unit-tested without the fs.
//
// Allowed character set for the path: alphanumerics, dot, slash, hyphen,
// underscore, tilde. Anything else is rejected.
//
// This is a whitelist rather than a blacklist for a reason. The launcher
// inlines the path into a tmux command via nested template literals, which
// produces a shell string with both an outer and an inner double-quoted
// region. Bash treats the inner `"` as a quote delimiter, not a literal,
// so the path actually lands partly inside and partly outside double-quote
// context. Inside double quotes most metachars are tame; outside, almost
// anything (parens, single quote, spaces, semicolons, &, |) is shell-
// significant. Enumerating "safe outside double quotes" by blacklist is a
// trap -- a whitelist of characters that survive both layers is far
// shorter to write and more robust to future changes in the launcher.
//
// Local config is only writable by the host operator, so this is defense-
// in-depth rather than a hard security boundary, but it cheaply removes
// the trivial way to break the launcher with a config typo.
//
// Path values containing `..` segments are also rejected. Without this
// guard `path.join` would silently collapse them ("~/../../../etc/passwd"
// resolves to "/etc/passwd"), which is almost never what the operator
// meant. Absolute paths without `..` remain accepted, so legitimate non-
// home locations like "/var/lib/claude-coding" still work.
const CLAUDE_CONFIG_DIR_ALLOWED = /^[A-Za-z0-9_./~-]+$/

// Only `..` segments are rejected, not `.` (current dir) or empty segments
// from doubled slashes (`//`). Both of those are no-ops -- the OS and
// `path.join` normalize them away without changing where the path points.
// `..` is the only segment that meaningfully alters the destination, so
// it's the only one we treat as suspicious.
function hasParentTraversal(raw: string): boolean {
  return raw.split('/').some(segment => segment === '..')
}

export function resolveClaudeConfigDir(
  rawConfigJson: string,
  homeDir: string,
): string | null {
  let config: unknown
  try { config = JSON.parse(rawConfigJson) } catch { return null }
  if (!config || typeof config !== 'object') return null
  const value = (config as Record<string, unknown>).claudeConfigDir
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  if (!CLAUDE_CONFIG_DIR_ALLOWED.test(raw)) return null
  if (hasParentTraversal(raw)) return null
  // Tilde may appear at most once, and only as the bare `~` or as the
  // leading `~/` of a `~/...` form. `~user`, mid-string `~`, double tildes
  // -- all rejected because the runtime shell would re-expand them at
  // assignment time even though our resolver does not, and we do not want
  // the launcher to silently route an agent to a different user's home
  // directory or to a path the operator did not write.
  if (raw.includes('~')) {
    const tildeCount = raw.split('~').length - 1
    const validForm = raw === '~' || raw.startsWith('~/')
    if (!validForm || tildeCount > 1) return null
  }
  let resolved: string
  if (raw === '~') resolved = homeDir
  else if (raw.startsWith('~/')) resolved = join(homeDir, raw.slice(2))
  else resolved = raw
  // Re-validate after expansion: if `homeDir` itself contains a character
  // outside the whitelist (e.g. a space in a multi-word account name), the
  // resolved path would land in unquoted shell context and break the
  // launcher cmd. Reject rather than ship a broken export.
  if (!CLAUDE_CONFIG_DIR_ALLOWED.test(resolved)) return null
  return resolved
}

// Optional per-agent override for the Claude Code config directory. When set,
// the launcher injects CLAUDE_CONFIG_DIR into the tmux command, letting that
// agent use a different login (credentials, plugins, sessions) than the host
// default. When null, no env var is injected and Claude Code uses its built-in
// default location (`~/.claude/` on macOS/Linux).
export function readAgentClaudeConfigDir(name: string): string | null {
  const configPath = join(agentDir(name), 'agent-config.json')
  return resolveClaudeConfigDir(readFileOr(configPath, '{}'), homedir())
}

export function readAgentChannelProvider(name: string): string | null {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    if (typeof config.channelProvider === 'string' && config.channelProvider.trim()) {
      return config.channelProvider.trim()
    }
  } catch { /* fall through */ }
  return null
}

export function writeAgentChannelProvider(name: string, provider: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.channelProvider = provider
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export type AuthMode = 'shared' | 'own_team' | 'api'

const VALID_AUTH_MODES = new Set<AuthMode>(['shared', 'own_team', 'api'])

export function readAgentAuthMode(name: string): AuthMode {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    if (typeof config.authMode === 'string' && VALID_AUTH_MODES.has(config.authMode as AuthMode)) {
      return config.authMode as AuthMode
    }
  } catch { /* fall through */ }
  return 'shared'
}

export function writeAgentAuthMode(name: string, mode: AuthMode): void {
  if (!VALID_AUTH_MODES.has(mode)) return
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.authMode = mode
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function writeAgentSecurityProfile(name: string, profileId: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.securityProfile = profileId
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

// Sentinel filename. A subdirectory under agents/ that contains this empty
// file is treated as a TECHNICAL worker, not a first-class agent: it stays
// out of listAgentNames() (so it never appears on the dashboard, in the
// schedule runner, in inter-agent message routing, etc.), but is still a
// real directory on disk for whatever workflow needs it. Used today by
// agents/heartbeat-worker/, the sentinel cwd for the SDK-spawned hourly
// heartbeat sub-agent (Szabi 2026-06-02: "ez a technikai agent meg se
// jelenjen a dashboardon").
export const HIDDEN_AGENT_SENTINEL = '.hidden-from-dashboard'

export function listAgentNames(): string[] {
  if (!existsSync(AGENTS_BASE_DIR)) return []
  return readdirSync(AGENTS_BASE_DIR).filter((f) => {
    try {
      if (!statSync(join(AGENTS_BASE_DIR, f)).isDirectory()) return false
      // Hide technical workers explicitly opted out via the sentinel
      // file. Cheap fs stat -- one extra existsSync per agent dir per
      // tick; the agent list is small (~6 today).
      if (existsSync(join(AGENTS_BASE_DIR, f, HIDDEN_AGENT_SENTINEL))) return false
      return true
    } catch { return false }
  })
}

// Does this identifier refer to a registered agent? MAIN_AGENT_ID always
// counts (it lives outside agents/ but is a first-class peer). Sub-agents
// need a directory on disk. One fs stat per call -- the router calls this
// twice per pending message on its 5s tick, roughly 10-20 stats per tick
// in practice, no memoisation needed.
export function isKnownAgent(name: string): boolean {
  if (!name) return false
  if (name === MAIN_AGENT_ID) return true
  try {
    const dir = agentDir(name)
    return existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// Normalise an inter-agent message recipient to a known agent NAME, or null
// when it cannot be resolved to one.
//
// The footgun this closes: callers (humans, scripts) routinely address a
// message to the tmux SESSION name ("agent-dave") instead of the agent NAME
// ("dave"). The session prefix is "agent-" + name, so "agent-dave" is not a
// known agent; the message used to queue, never match a real agent in the
// router, and silently vanish in the pending state forever.
//
// Resolution order:
//   1. trimmed input is already a known agent  -> keep it verbatim
//   2. strip a SINGLE leading "agent-" prefix and re-check  -> the stripped name
//   3. otherwise -> null (caller rejects with a 400)
//
// Only one "agent-" prefix is stripped: an agent literally named "agent-foo"
// is not expressible (the session would be "agent-agent-foo"), so collapsing
// repeated prefixes would only mask typos, not serve a real address.
//
// `isKnown` is injectable so the resolution logic can be unit-tested without
// the filesystem; it defaults to the real isKnownAgent for production callers.
export function normalizeRecipient(
  to: string,
  isKnown: (name: string) => boolean = isKnownAgent,
): string | null {
  const trimmed = (to ?? '').trim()
  if (!trimmed) return null
  if (isKnown(trimmed)) return trimmed
  if (trimmed.startsWith('agent-')) {
    const stripped = trimmed.slice('agent-'.length)
    if (isKnown(stripped)) return stripped
  }
  return null
}
