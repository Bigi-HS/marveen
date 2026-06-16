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

// The per-model facts the fleet needs in ONE typed place (card b83e7c92 item-1).
// This replaces the bare window-only map: window sizes the proactive /compact
// threshold (a 200K Sonnet/Haiku must compact far earlier than a 1M Opus), the
// list prices feed the planned per-agent cost rollup (card bb4992dc), the
// deprecation date drives stale-model warnings, and supports1M marks the
// long-context variant. These facts were previously hand-maintained across the
// window map + the model-migration memory; this const is now their single
// source of truth. Keys are full model ids (alias-resolved before lookup).
export interface ModelInfo {
  /** Total context window, in tokens. */
  window: number
  /** Anthropic list price, USD per million INPUT tokens. 0 for local models. */
  inputPricePerMTok: number
  /** Anthropic list price, USD per million OUTPUT tokens. 0 for local models. */
  outputPricePerMTok: number
  /** Anthropic list price, USD per million CACHE-READ (hit) tokens. 0 for local
   * models. Published as 0.1x the base input rate. */
  cacheReadPerMTok: number
  /** Anthropic list price, USD per million CACHE-WRITE tokens (5-minute TTL,
   * which is what the harness uses). 0 for local models. Published as 1.25x the
   * base input rate. The 1-hour write tier (2x) is not modelled. */
  cacheWritePerMTok: number
  /** ISO date (YYYY-MM-DD) the model retires, or null when none is announced. */
  deprecationDate: string | null
  /** True only for the 1M-context variant of a model. */
  supports1M: boolean
}

// Prices are Anthropic published list rates (USD per MTok), verified 2026-06
// against platform.claude.com/pricing; this is the one place to update them on a
// price change. Local Ollama models cost nothing per token (priced 0) so the
// cost rollup attributes them as free. NOTE: Opus 4.8 standard usage is $5/$25
// (the older Opus 4.0 was $15/$75 -- see the retired row below); fast mode
// ($10/$50) and the 1M-context >200K-token surcharge are NOT modelled here (base
// rate only). Cache rates are the published cache columns: cache read (hit) =
// 0.1x base input, 5-minute cache write = 1.25x base input (the 1-hour 2x write
// tier is not modelled -- the harness uses the 5-minute ephemeral cache). These
// were verified against the published per-model cache columns, not just derived
// from the multipliers (cache_read dominates the spend per token-burn-anatomy,
// so a wrong rate here would mis-state the cost rollup's dominant component).
export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  'claude-opus-4-8[1m]':       { window: 1_000_000, inputPricePerMTok: 5,  outputPricePerMTok: 25, cacheReadPerMTok: 0.5,  cacheWritePerMTok: 6.25,  deprecationDate: null, supports1M: true },
  'claude-opus-4-8':           { window: 200_000,   inputPricePerMTok: 5,  outputPricePerMTok: 25, cacheReadPerMTok: 0.5,  cacheWritePerMTok: 6.25,  deprecationDate: null, supports1M: false },
  'claude-sonnet-4-6':         { window: 200_000,   inputPricePerMTok: 3,  outputPricePerMTok: 15, cacheReadPerMTok: 0.3,  cacheWritePerMTok: 3.75,  deprecationDate: null, supports1M: false },
  'claude-haiku-4-5-20251001': { window: 200_000,   inputPricePerMTok: 1,  outputPricePerMTok: 5,  cacheReadPerMTok: 0.1,  cacheWritePerMTok: 1.25,  deprecationDate: null, supports1M: false },
  'claude-haiku-4-5':          { window: 200_000,   inputPricePerMTok: 1,  outputPricePerMTok: 5,  cacheReadPerMTok: 0.1,  cacheWritePerMTok: 1.25,  deprecationDate: null, supports1M: false },
  'qwen3:4b':                  { window: 32_768,    inputPricePerMTok: 0,  outputPricePerMTok: 0,  cacheReadPerMTok: 0,    cacheWritePerMTok: 0,     deprecationDate: null, supports1M: false },
  // Retired models (model-migration-2026-06): kept so a stale agent-config still
  // referencing them trips a deprecation warning instead of silent fallback.
  'claude-sonnet-4-0':         { window: 200_000,   inputPricePerMTok: 3,  outputPricePerMTok: 15, cacheReadPerMTok: 0.3,  cacheWritePerMTok: 3.75,  deprecationDate: '2026-06-15', supports1M: false },
  'claude-opus-4-0':           { window: 200_000,   inputPricePerMTok: 15, outputPricePerMTok: 75, cacheReadPerMTok: 1.5,  cacheWritePerMTok: 18.75, deprecationDate: '2026-06-15', supports1M: false },
}

// Back-compat projection: the old window-only map, derived from the registry so
// the two can never drift. Existing importers keep working unchanged.
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  Object.entries(MODEL_REGISTRY).map(([id, info]) => [id, info.window]),
)

// Default context window for any model id we don't explicitly know. 200K is the
// standard Claude window and the safe (smaller) assumption: it makes us compact
// earlier rather than risk running a large session past its real limit.
export const DEFAULT_CONTEXT_WINDOW = 200_000

// The full registry row for a model id (alias-resolved), or null when unknown.
export function modelInfoForModel(modelId: string | null | undefined): ModelInfo | null {
  if (!modelId || typeof modelId !== 'string') return null
  return MODEL_REGISTRY[resolveModelId(modelId.trim())] ?? null
}

// Resolve a model id (alias or full) to its context window in tokens. Strips the
// alias indirection first so 'opus'/'sonnet'/'haiku' resolve too. Falls back to
// DEFAULT_CONTEXT_WINDOW for unknown ids (and for a null/empty input).
export function contextWindowForModel(modelId: string | null | undefined): number {
  return modelInfoForModel(modelId)?.window ?? DEFAULT_CONTEXT_WINDOW
}

// USD cost of a turn's token usage at the model's list price, or null when the
// model is unknown (the caller cannot price it). Negative/missing counts clamp
// to zero so a bad usage reading never produces a negative cost.
export function costForUsageUsd(
  modelId: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const info = modelInfoForModel(modelId)
  if (!info) return null
  const inTok = inputTokens > 0 ? inputTokens : 0
  const outTok = outputTokens > 0 ? outputTokens : 0
  return (inTok / 1_000_000) * info.inputPricePerMTok + (outTok / 1_000_000) * info.outputPricePerMTok
}

/** The four billable token components of a turn. All optional; omitted/negative
 * counts price as zero. cacheRead = cache hits (cheap, but dominant in volume);
 * cacheCreation = cache writes. */
export interface DetailedUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
}

// Cache-aware USD cost of a turn, pricing all four token components at the
// model's published rates, or null when the model is unknown. This is the rollup
// helper (card bb4992dc): unlike costForUsageUsd it prices cache_read and
// cache_creation, which token-burn-anatomy shows dominate real spend -- ignoring
// them would mis-state the dominant component. Negative/missing counts clamp to
// zero. costForUsageUsd is left untouched for its existing input+output callers.
export function costForUsageDetailedUsd(
  modelId: string | null | undefined,
  usage: DetailedUsage,
): number | null {
  const info = modelInfoForModel(modelId)
  if (!info) return null
  const clamp = (n: number | undefined): number => (n && n > 0 ? n : 0)
  return (
    (clamp(usage.input) / 1_000_000) * info.inputPricePerMTok +
    (clamp(usage.output) / 1_000_000) * info.outputPricePerMTok +
    (clamp(usage.cacheRead) / 1_000_000) * info.cacheReadPerMTok +
    (clamp(usage.cacheCreation) / 1_000_000) * info.cacheWritePerMTok
  )
}

// Whether a model is retired as of the given ISO date (YYYY-MM-DD). False for an
// unknown model or one with no announced retirement. ISO dates sort
// lexicographically, so a plain string compare is correct.
export function isModelDeprecated(modelId: string | null | undefined, asOfIsoDate: string): boolean {
  const info = modelInfoForModel(modelId)
  if (!info || !info.deprecationDate) return false
  return asOfIsoDate >= info.deprecationDate
}

// Whether a model id is the 1M-context variant. False for unknown ids.
export function modelSupports1M(modelId: string | null | undefined): boolean {
  return modelInfoForModel(modelId)?.supports1M ?? false
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
  // Read through the resolving loader so the channel-launch path is the live
  // consumer of the secret-pointer wiring (channelProvider itself is not a
  // secret -- it is left untouched -- but a future channel apiKey/token field
  // written as {env:}/{file:} would resolve here on the same read).
  const config = readAgentConfig(name)
  if (typeof config.channelProvider === 'string' && config.channelProvider.trim()) {
    return config.channelProvider.trim()
  }
  return null
}

/** Result of a fail-soft channel-provider read. */
export interface ChannelProviderRead {
  /** The configured provider, or null when none is configured (channel-less). */
  provider: string | null
  /** True when the provider could not be read (e.g. a misconfigured secret
   *  pointer in a whitelisted config key). Callers treat this as fail-soft: no
   *  channel is launched, but the agent is NOT crashed. */
  misconfigured: boolean
  /** The error message when misconfigured (for the health surface / logs). */
  error?: string
}

// readAgentChannelProvider() reads through the secret-pointer resolving loader
// (readAgentConfig -> resolveConfigSecrets), which throws SecretPointerError
// fail-closed on a misconfigured pointer ({file:} to a missing file, an unset
// {env:}). An unhandled throw in the agent launch / health / channel-monitor
// path would crash agent startup on a single bad config, so every such caller
// MUST read through this fail-soft wrapper instead. Today inactive (no live
// agent-config field is a secret pointer), this is the pre-deploy guard for
// when a live config-pointer field (e.g. a channel apiToken) is introduced.
export function readAgentChannelProviderSafe(name: string): ChannelProviderRead {
  try {
    return { provider: readAgentChannelProvider(name), misconfigured: false }
  } catch (err) {
    return {
      provider: null,
      misconfigured: true,
      error: err instanceof Error ? err.message : String(err),
    }
  }
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

// --- Secret-pointer resolver (card b83e7c92 item-5) -----------------------
//
// Resolves {env:VAR_NAME} and {file:relative/path} placeholders so agent
// configs can reference secrets by pointer rather than embedding them inline.
// Canonical use: {file:store/.dashboard-token}, {env:GH_PAT}.
//
// Rules:
//  - Only WHOLE-VALUE placeholders are resolved (not embedded substrings).
//  - {env:VAR} -- env var name must match [A-Z_][A-Z0-9_]* (strict form).
//  - {file:path} -- path must be relative (no leading / or ~), no .. segments.
//    Resolved relative to projectRoot (defaults to PROJECT_ROOT). The resolved
//    path must remain inside projectRoot.
//  - File content is trimEnd()-trimmed (token files end with \n).
//  - Errors are fail-closed: unresolvable pointer -> throw SecretPointerError.
//    Error messages carry the pointer address (name/path) but NEVER the secret.
//  - Plain strings (no placeholder) pass through unchanged.

export class SecretPointerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretPointerError'
  }
}

// Strict: [A-Z_][A-Z0-9_]* anchored, so lowercase/digit-start/spaces all fail.
const ENV_POINTER_RE = /^\{env:([A-Z_][A-Z0-9_]*)\}$/
// File path: everything up to the closing } (validated below, not via regex).
const FILE_POINTER_RE = /^\{file:([^}]*)\}$/

export function resolveSecretPointer(value: string, projectRoot: string = PROJECT_ROOT): string {
  // {env:VAR_NAME}
  const envMatch = ENV_POINTER_RE.exec(value)
  if (envMatch) {
    const name = envMatch[1]
    const resolved = process.env[name]
    if (resolved === undefined) {
      throw new SecretPointerError(`{env:${name}} is not set`)
    }
    return resolved
  }

  // {file:relative/path}
  const fileMatch = FILE_POINTER_RE.exec(value)
  if (fileMatch) {
    const rawPath = fileMatch[1].trim()
    if (!rawPath) {
      throw new SecretPointerError('{file:} path is empty')
    }
    // Reject absolute paths (leading / or ~).
    if (rawPath.startsWith('/') || rawPath.startsWith('~')) {
      throw new SecretPointerError(
        `{file:${rawPath}} must be a relative path (no leading / or ~)`
      )
    }
    // Reject %2e%2e and similar URL-encoded traversal patterns.
    if (rawPath.includes('%')) {
      throw new SecretPointerError(
        `{file:${rawPath}} contains percent-encoded characters (not allowed)`
      )
    }
    // Reject .. segments.
    if (hasParentTraversal(rawPath)) {
      throw new SecretPointerError(`{file:${rawPath}} contains parent traversal (..)`)
    }
    const resolved = join(projectRoot, rawPath)
    // Double-check after join normalization: resolved path must be inside root.
    const rootWithSep = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/'
    if (!resolved.startsWith(rootWithSep) && resolved !== projectRoot) {
      throw new SecretPointerError(
        `{file:${rawPath}} resolves outside project root`
      )
    }
    try {
      return readFileSync(resolved, 'utf-8').trimEnd()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
      throw new SecretPointerError(`{file:${rawPath}} is not readable (${code})`)
    }
  }

  // Not a placeholder -- return unchanged.
  return value
}

// ── secret-pointer config wiring (card 846aa0ac) ──────────────────────────────
// Wire resolveSecretPointer into agent-config loading so a secret-bearing field
// can be written as {env:VAR} / {file:relpath} instead of an inline secret.
//
// WHITELIST semantics (NoA decision): resolution runs ONLY on secret-semantic
// keys, and ONLY when the value is actually a pointer. A plain string is NEVER
// touched -- so a human-readable field that merely looks pointer-ish cannot be
// mangled. Human-readable fields (displayName, name, persona, model, prompt,
// catchphrase, ...) are NEVER in scope. The match is case-insensitive: an exact
// key in the set, OR a key ending in a sensitive suffix (*Token/*Secret/*ApiKey/
// *Password). Today no live agent-config field is a secret, so this is wired but
// inactive -- a no-op on every current config, ready for a future secret field.
const SECRET_KEY_EXACT = new Set([
  'apikey', 'api_key', 'token', 'secret', 'clientsecret', 'password', 'webhookurl',
])
const SECRET_KEY_SUFFIXES = ['token', 'secret', 'apikey', 'password']

export function isSecretPointerKey(key: string): boolean {
  const k = key.toLowerCase()
  if (SECRET_KEY_EXACT.has(k)) return true
  // suffix match, but only for keys LONGER than the suffix (exact words are
  // already covered above, and this avoids e.g. matching the bare word twice).
  return SECRET_KEY_SUFFIXES.some((s) => k.length > s.length && k.endsWith(s))
}

// Pointer SHAPE gate: only attempt resolution when the value opens with a
// {env:/{file: placeholder. resolveSecretPointer does the full validation; this
// just avoids calling it (and avoids its throw surface) for plain strings.
const SECRET_POINTER_SHAPE_RE = /^\{(?:env|file):/

// Resolve secret pointers in a parsed config object: for each WHITELISTED key
// whose string value is pointer-shaped, replace it with the resolved secret.
// Everything else (non-whitelisted keys, non-string values, plain strings) is
// returned untouched. Fail-closed: an unresolvable pointer in a whitelisted key
// throws SecretPointerError (a misconfigured secret must surface loudly, never
// silently launch with an empty/bad credential). Shallow by design -- agent
// config is flat; nested resolution is a future extension if a need appears.
export function resolveConfigSecrets(
  config: Record<string, unknown>,
  projectRoot: string = PROJECT_ROOT,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config }
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string') continue
    if (!isSecretPointerKey(key)) continue
    if (!SECRET_POINTER_SHAPE_RE.test(value)) continue
    out[key] = resolveSecretPointer(value, projectRoot)
  }
  return out
}

// Canonical accessor: read an agent's full config with secret pointers (in
// whitelisted keys) resolved. Returns {} when the file is absent/unparseable.
// This is the wiring point -- any code needing a secret-bearing config field
// must read it through here so the pointer auto-resolves.
export function readAgentConfig(name: string): Record<string, unknown> {
  const configPath = join(agentDir(name), 'agent-config.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileOr(configPath, '{}'))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return resolveConfigSecrets(parsed as Record<string, unknown>)
}
