import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  rmSync,
  symlinkSync,
  copyFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { agentDir } from './agent-config.js'

// Channel plugin ids. The isolated config dir's settings.json is the USER
// scope; channel enable/disable must NOT live here, otherwise it collides with
// the PROJECT-scope .claude/settings.json that the launcher + setAgentEnabledPlugins
// already own. (Observed live: dave's config-dir settings.json carried a stale
// telegram:false from manual channel-less setup, and when dave later gained a
// real Telegram channel the project-scope true and config-scope false had to be
// reconciled by hand in two places.) So we keep this list only to STRIP these
// keys out of the config-dir settings.json on every build, keeping it channel-
// neutral. Channel on/off is decided in exactly one place: project scope.
export const CHANNEL_PLUGIN_IDS = [
  'telegram@claude-plugins-official',
  'slack-channel@marveen-marketplace',
  'discord@claude-plugins-official',
] as const

// Entries under ~/.claude/ that must NOT be symlinked into an isolated config
// dir.
//   - settings.json: OWNED (we may flip channel plugins for a channel-less
//     agent), so it is written, never symlinked.
//   - .claude.json is not under ~/.claude/ (it is the ~/.claude.json sibling)
//     but is listed defensively in case a future Claude Code version moves it
//     inside; it is materialised as a private COPY, which is the whole point
//     of this module (see below).
//   - .lock / .DS_Store / .last-cleanup: host-local noise, never shared.
const CONFIG_LINK_SKIP = new Set([
  'settings.json',
  '.claude.json',
  '.DS_Store',
  '.lock',
  '.last-cleanup',
])

interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>
  [key: string]: unknown
}

export interface BuildAgentConfigDirParams {
  // Destination isolated config dir, e.g. agents/<name>/.claude-config.
  configDir: string
  // The agent's working directory at launch (its cwd). Used as the projects[]
  // key seeded into the private .claude.json so the agent inherits the main
  // agent's MCP-server approvals from its own cwd.
  agentCwd: string
  // Source ~/.claude directory (symlink donor for shared state).
  realClaudeDir: string
  // Source ~/.claude.json (copied, not symlinked -- see writePrivateClaudeJson).
  realClaudeJsonPath: string
  // The main agent's project root: source of the projects[] entry whose
  // MCP-server config/approvals are duplicated into the agent's cwd key.
  projectRoot: string
}

function lstatSyncSafe(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

// Ensure linkPath is a symlink to target. A pre-existing symlink (any target)
// is left as-is; anything else (stale regular file/dir from a manual edit or a
// previous non-symlink layout) is removed and re-created so the isolation
// cannot be silently defeated. Failures are logged, not thrown -- a single
// missing link degrades the sub-agent but should not abort the whole build.
function ensureSymlink(target: string, linkPath: string): void {
  const st = lstatSyncSafe(linkPath)
  if (st) {
    if (st.isSymbolicLink()) return
    try {
      rmSync(linkPath, { recursive: true, force: true })
    } catch {
      /* will attempt the symlink anyway */
    }
  }
  try {
    symlinkSync(target, linkPath)
  } catch (err) {
    logger.warn({ err, target, linkPath }, 'agent-config-dir: failed to symlink shared config entry')
  }
}

// Write the owned settings.json, kept CHANNEL-NEUTRAL. Base precedence: an
// existing OWNED (regular-file) settings.json in the config dir wins -- so
// operator/agent edits survive a rebuild -- otherwise the host's
// ~/.claude/settings.json is the seed (carrying theme, marketplaces, etc.). A
// symlinked settings.json left over from an earlier layout is removed so we own
// the file.
//
// The only mutation this makes is STRIPPING channel-plugin keys out of
// enabledPlugins (see CHANNEL_PLUGIN_IDS): channel enable/disable belongs to
// the project-scope .claude/settings.json alone, so the config-dir user-scope
// must not carry a competing copy. Stripping also cleans up stale channel
// state seeded by an earlier manual setup.
function writePrivateSettings(p: BuildAgentConfigDirParams): void {
  const dest = join(p.configDir, 'settings.json')
  const destStat = lstatSyncSafe(dest)
  if (destStat?.isSymbolicLink()) {
    // Reading through a symlink would import the host enabledPlugins map and
    // re-introduce channel state; remove it so the write below owns the file.
    try {
      rmSync(dest, { force: true })
    } catch {
      /* fall through to write */
    }
  }

  let base: ClaudeSettings = {}
  const ownExists = !!destStat && !destStat.isSymbolicLink()
  const seedPath = ownExists ? dest : join(p.realClaudeDir, 'settings.json')
  if (existsSync(seedPath)) {
    try {
      const parsed = JSON.parse(readFileSync(seedPath, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as ClaudeSettings
      }
    } catch (err) {
      logger.warn({ err, seedPath }, 'agent-config-dir: failed to parse seed settings.json, starting empty')
    }
  }

  let changed = !ownExists
  if (base.enabledPlugins && typeof base.enabledPlugins === 'object') {
    for (const plugin of CHANNEL_PLUGIN_IDS) {
      if (plugin in base.enabledPlugins) {
        delete base.enabledPlugins[plugin]
        changed = true
      }
    }
    // Drop the map entirely if stripping emptied it, so the config-dir
    // settings.json carries no enabledPlugins key at all.
    if (Object.keys(base.enabledPlugins).length === 0) {
      delete base.enabledPlugins
      changed = true
    }
  }
  if (!changed) return
  writeFileSync(dest, JSON.stringify(base, null, 2) + '\n')
}

// Materialise a PRIVATE copy of ~/.claude.json inside the config dir. THIS IS
// THE LOCK FIX: every agent otherwise reads/writes the single shared
// ~/.claude.json, and Claude Code takes an exclusive file lock when saving it.
// Under WSL the freshly launched sub-agent loses the race against the main
// agent's lock ("Failed to save config with lock: Lock file is already being
// held") and exits with code 1 within ~1s, silently, inside tmux. With
// CLAUDE_CONFIG_DIR pointed here, the agent locks THIS file instead, so there
// is no cross-agent contention.
//
// Seed-if-missing (not overwrite-every-launch): once the private copy exists
// it is the agent's own accumulated state (onboarding flags, per-cwd history)
// and must not be clobbered on every restart. The agent keeps its own
// .mcp.json for project-scope MCP servers, so a stale projects[] map here is
// not load-bearing. Delete the file to force a fresh re-seed.
//
// On seed, the host's projects[projectRoot] entry is duplicated under
// projects[agentCwd] so the agent inherits the main agent's MCP-server
// approvals from its own working directory key (mirrors the heartbeat worker).
// Written mode 0600 because it can hold OAuth-adjacent project state.
function writePrivateClaudeJson(p: BuildAgentConfigDirParams): void {
  const dest = join(p.configDir, '.claude.json')
  if (existsSync(dest)) return
  if (!existsSync(p.realClaudeJsonPath)) return
  try {
    const parsed = JSON.parse(readFileSync(p.realClaudeJsonPath, 'utf-8')) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') {
      copyFileSync(p.realClaudeJsonPath, dest)
      return
    }
    const projects = (parsed as { projects?: Record<string, unknown> }).projects
    if (
      projects &&
      typeof projects === 'object' &&
      projects[p.projectRoot] &&
      !projects[p.agentCwd]
    ) {
      projects[p.agentCwd] = projects[p.projectRoot]
    }
    writeFileSync(dest, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
  } catch (err) {
    logger.warn({ err }, 'agent-config-dir: failed to seed private .claude.json (agent may contend on host config lock)')
  }
}

// Build an isolated CLAUDE_CONFIG_DIR for one sub-agent: shared state (auth,
// projects, plugins, marketplaces) symlinked back to ~/.claude/, but a PRIVATE
// settings.json and a PRIVATE .claude.json so the agent does not fight the
// shared ~/.claude.json file lock. Idempotent; safe to call on every launch.
export function buildAgentConfigDir(p: BuildAgentConfigDirParams): void {
  mkdirSync(p.configDir, { recursive: true })

  if (existsSync(p.realClaudeDir)) {
    for (const entry of readdirSync(p.realClaudeDir)) {
      if (CONFIG_LINK_SKIP.has(entry)) continue
      ensureSymlink(join(p.realClaudeDir, entry), join(p.configDir, entry))
    }
  }

  writePrivateSettings(p)
  writePrivateClaudeJson(p)
}

// Thin wrapper: resolve the real host paths for an agent by name and build its
// isolated config dir at the canonical agents/<name>/.claude-config location.
// Returns the config dir path so the launcher can export it as
// CLAUDE_CONFIG_DIR. On failure, still returns the path (the agent will fall
// back to contending on the shared lock, the pre-fix status quo) -- a build
// error must never block a launch outright.
export function ensureAgentConfigDir(name: string): string {
  const dir = agentDir(name)
  const configDir = join(dir, '.claude-config')
  try {
    buildAgentConfigDir({
      configDir,
      agentCwd: dir,
      realClaudeDir: join(homedir(), '.claude'),
      realClaudeJsonPath: join(homedir(), '.claude.json'),
      projectRoot: PROJECT_ROOT,
    })
  } catch (err) {
    logger.warn({ err, name, configDir }, 'agent-config-dir: ensureAgentConfigDir failed; agent may contend on ~/.claude.json lock')
  }
  return configDir
}
