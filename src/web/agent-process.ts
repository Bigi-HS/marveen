import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { OLLAMA_URL, PROJECT_ROOT } from '../config.js'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import {
  detectPaneState,
  decideSubmitFollowup,
  shouldClearTruncatedPreamble,
} from '../pane-state.js'
import { agentDir, readAgentModel, readAgentSecurityProfile, readAgentClaudeConfigDir, readAgentChannelProviderSafe, readAgentAuthMode, readAgentDisplayName } from './agent-config.js'
import { ensureAgentConfigDir } from './agent-config-dir.js'
import { parseTelegramToken } from './telegram.js'
import { getProvider, getProviderType, channelStateDir, readChannelToken, channelIntentFromEnabledPlugins, type ChannelProviderType } from '../channel-provider.js'
import { CHANNEL_PROVIDER } from '../config.js'
import { loadProfileTemplate } from './profiles.js'
import { writeAgentSettingsFromProfile } from './agent-scaffold.js'
import { getSecret } from './vault.js'
import { backupChannelEnv, restoreChannelEnv } from './channel-token-durability.js'
import { reapChannelOrphans, reapDetachedChannelClaudes } from './channel-poller-reap.js'
import { runPreflight, logPreflightFindings, summarizePreflightErrors } from './agent-preflight.js'
import { provisionAgentToken } from './agent-token-provision.js'
import { getDb } from '../db.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')

// Canonical fleet OAuth helper (PR #85). Sourcing it exports
// CLAUDE_CODE_OAUTH_TOKEN from the static setup-token into the launched
// agent's environ, overriding a stale symlinked .credentials.json. The bash
// watchdogs already source it; this path covers the DASHBOARD launch (restart
// button, chameleon sandbox, scaffold) that the bash migration could not reach.
const FLEET_OAUTH_HELPER = join(PROJECT_ROOT, 'scripts', 'lib', 'fleet-oauth-env.sh')

// Per-agent dashboard-token helper (card b1ce5118). Sourcing it exports
// GENESIS_AGENT_TOKEN -- the launched agent's OWN dashboard bearer -- so its
// /api calls authenticate as itself and the server derives its identity from
// the credential. Mirrors the OAuth helper exactly (env-only, never logged,
// no-op fallback). Inert until the fleet-ops recipe flips to it (C-BIND).
const AGENT_TOKEN_HELPER = join(PROJECT_ROOT, 'scripts', 'lib', 'agent-token-env.sh')

// How many times startAgentProcess will (re)spawn the tmux session when the
// inner claude dies inside the liveness window. Two total attempts: the
// isolated config dir removes the lock-contention root cause, the single
// retry absorbs the residual node-spawn flake.
const LAUNCH_MAX_ATTEMPTS = 2
// Settle window after `tmux new-session` before probing liveness. The silent
// exit-1 was observed within ~1s; 2s clears it with margin while staying
// inside the dashboard Start button's acceptable latency.
const LAUNCH_LIVENESS_DELAY_S = 2
// Settle window after tearing down a DEAD attempt, before the next launch.
// When attempt 0 crashes (e.g. `claude --continue` on a stale deferred-tool
// marker), its dying process may still hold the per-agent config-dir
// `.claude.json` lock for a beat. Spawning the fallback launch immediately
// lets it lose that lock race and exit 1 silently too -- the same WSL bug the
// isolated config dir fixes for the steady state, re-introduced by two claude
// processes touching one config dir back-to-back. A short settle lets the dead
// process fully release before the retry.
const LAUNCH_RETRY_SETTLE_S = 3

// Pure launch-retry decision so the spawn loop is unit-testable without tmux.
// `running` is the post-settle liveness probe; `attempt` is 0-based; `maxAttempt`
// is the highest attempt index allowed (LAUNCH_MAX_ATTEMPTS - 1).
export function decideLaunchRetry(
  running: boolean,
  attempt: number,
  maxAttempt: number,
): 'ok' | 'retry' | 'give-up' {
  if (running) return 'ok'
  if (attempt < maxAttempt) return 'retry'
  return 'give-up'
}

// Whether a given launch attempt should carry `--continue`.
//
// `claude --continue` resumes the prior transcript, but if that transcript
// ended parked on a stale deferred-tool marker, `claude` exits 1 with
// "No deferred tool marker found in the resumed session" inside the liveness
// window. Re-running the SAME --continue command (the old retry behaviour)
// just fails again -> the agent stays DOWN with an empty pane and no resume
// menu. So only the FIRST attempt resumes; any retry after a liveness-window
// death drops --continue and starts a FRESH session. The in-session transcript
// is lost, but durable state lives in the memory system, so a fresh boot is an
// acceptable fallback that beats a dead agent. Pure so it is unit-testable.
export function shouldContinueSession(hasPriorSession: boolean, attempt: number): boolean {
  return hasPriorSession && attempt === 0
}

function resolveAgentProvider(name: string): ChannelProviderType {
  // Fail-soft: a misconfigured secret pointer must not crash the launch path
  // (agentHasChannel / isAgentChannelIntentionallyEnabled both route through
  // here) -- fall back to the default provider on an unreadable config.
  const perAgent = readAgentChannelProviderSafe(name).provider
  if (perAgent === 'slack' || perAgent === 'telegram' || perAgent === 'discord') return perAgent
  return CHANNEL_PROVIDER
}

export function agentSessionName(name: string): string {
  return `agent-${name}`
}

export function isAgentRunning(name: string): boolean {
  try {
    const output = execSync(`${TMUX} list-sessions -F "#{session_name}"`, { timeout: 3000, encoding: 'utf-8' })
    return output.split('\n').some(line => line.trim() === agentSessionName(name))
  } catch {
    return false
  }
}

// True if a tmux session with the EXACT given name is alive. Addresses sessions
// the `agent-<name>` template does not cover -- notably the main orchestrator's
// `${id}-channels` session (MAIN_CHANNELS_SESSION), which is why isAgentRunning
// (template-only) cannot be used to gate work on the main agent.
export function isTmuxSessionAlive(session: string): boolean {
  try {
    execFileSync(TMUX, ['has-session', '-t', session], { timeout: 3000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function getAgentRunningSince(name: string): number | null {
  try {
    const out = execFileSync(
      TMUX,
      ['display-message', '-p', '-t', agentSessionName(name), '#{session_created}'],
      { timeout: 3000, encoding: 'utf-8' },
    ).trim()
    const ts = parseInt(out, 10)
    return Number.isFinite(ts) ? ts : null
  } catch {
    return null
  }
}


export function agentHasChannel(name: string): boolean {
  const agentProvider = resolveAgentProvider(name)
  const dir = agentDir(name)
  const agentChannelDir = channelStateDir(agentProvider, dir)
  const token = readChannelToken(agentProvider, join(agentChannelDir, '.env'))
  if (token) return true
  if (agentProvider === 'telegram') return !!parseTelegramToken(name)
  return false
}

/**
 * Returns true only when the agent's channel plugin is INTENTIONALLY enabled
 * -- not merely because a token file happens to exist.
 *
 * Source of truth is the agent's LAUNCH settings, <dir>/.claude/settings.json,
 * because that is the file the launcher actually writes and respects:
 *  - a channel-less launch force-disables telegram/slack/discord there
 *    (see startAgentProcess), so an inter-agent-only sub-agent reads false here
 *    and the channel monitor will NOT restart-loop it on a missing plugin;
 *  - a channel-enabled agent keeps its provisioned `<provider>@...: true`, so
 *    its dead poller IS eligible for auto-recovery.
 *
 * NOTE: we deliberately do NOT read <dir>/.claude-config/settings.json -- that
 * config-dir copy is channel-neutral (plugin keys stripped at build time), so
 * it reported `false` for EVERY config-dir agent and silently disabled channel
 * recovery fleet-wide (the ed2525f1 gap). The launch settings carry the intent.
 *
 * When the launch settings.json is absent or unreadable we return FALSE, not
 * token-presence: a bare token file is NOT intent. Treating an orphan token as
 * intent reintroduces the exact death-loop / false-reconnect we guard against
 * (Thor T3) -- the channel monitor would try to recover a channel that was never
 * actually brought up. A genuinely channel-enabled agent always has its plugin
 * enabled in .claude/settings.json (the launcher writes it on every launch), so
 * "no confirmable intent" safely resolves to "not enabled".
 */
export function isAgentChannelIntentionallyEnabled(name: string): boolean {
  const provider = resolveAgentProvider(name)
  const dir = agentDir(name)
  const launchSettings = join(dir, '.claude', 'settings.json')
  if (existsSync(launchSettings)) {
    try {
      const parsed = JSON.parse(readFileSync(launchSettings, 'utf-8'))
      return channelIntentFromEnabledPlugins(parsed?.enabledPlugins as Record<string, unknown> | undefined, provider)
    } catch { /* unreadable -> cannot confirm intent -> false */ }
  }
  // No (or unreadable) launch settings.json: cannot confirm intent. A bare token
  // file is not intent (orphan-token death-loop guard, Thor T3).
  return false
}

export function startAgentProcess(name: string, opts: { fresh?: boolean } = {}): { ok: boolean; pid?: number; error?: string } {
  if (isAgentRunning(name)) return { ok: false, error: 'Agent is already running' }

  const dir = agentDir(name)
  if (!existsSync(dir)) return { ok: false, error: 'Agent not found' }

  // A2 preflight: fail fast with a clear message on the known launch footguns
  // (missing binary, bad model id, symlinked config-dir .claude.json) instead
  // of a silent death seconds later. Warn-level findings (ambiguous channel
  // state, missing-but-auto-seeded .claude.json) are logged but do not block.
  const preflight = runPreflight(name)
  logPreflightFindings(name, preflight)
  if (!preflight.ok) {
    return { ok: false, error: `preflight failed: ${summarizePreflightErrors(preflight)}` }
  }

  const agentProvider = resolveAgentProvider(name)
  const provider = getProvider(agentProvider)
  const agentChannelDir = channelStateDir(agentProvider, dir)
  const envPath = join(agentChannelDir, '.env')
  // Channel-token durability: the .env lives inside the scaffold tree, so a
  // re-scaffold can wipe it. If it is gone, re-materialise it from the durable
  // vault mirror (store/vault.json, outside the agent dirs); if it is present,
  // refresh the mirror so a later rebuild can restore it. Both are best-effort
  // and never block the launch.
  if (existsSync(envPath)) {
    backupChannelEnv(name, agentProvider, envPath)
  } else {
    restoreChannelEnv(name, agentProvider, envPath)
  }
  const token = readChannelToken(agentProvider, envPath)
  // Backward compat: try legacy Telegram token if provider-aware lookup misses
  let hasChannel = !!token
  if (!token && agentProvider === 'telegram') {
    const legacyToken = parseTelegramToken(name)
    hasChannel = !!legacyToken
    // Channel-less agents (inter-agent only, no direct Telegram/Slack) are allowed to start
  }

  const session = agentSessionName(name)

  try {
    try {
      execSync(`${TMUX} kill-session -t ${session} 2>/dev/null`, { timeout: 3000 })
      execSync('sleep 3', { timeout: 5000 })
    } catch { /* ok */ }

    // Reap any orphan poller (bun/node) left over from a previous run BEFORE
    // we spawn the new tmux session. The plugin process is a grandchild of
    // the tmux server, so a tmux kill-session does not always tear it down -
    // it can be orphaned and keep polling getUpdates with the agent's bot
    // token, racing the freshly-spawned poller and producing 409 Conflict on
    // a roughly hourly cadence. See channel-poller-reap.ts.
    try {
      const agentProvider = resolveAgentProvider(name)
      const dir = agentDir(name)
      reapChannelOrphans(agentProvider, dir)
    } catch (err) {
      logger.warn({ err, name }, 'pre-launch channel-poller reap failed (continuing)')
    }

    // Also reap DETACHED channel claudes (the parent-process leak): a prior
    // --continue session that survived kill-session keeps a poller 409-racing
    // this agent's bot token, which the health monitor reads as "down" and
    // restarts -- a self-feeding thrash loop (zara, 2026-06-03). We just killed
    // this agent's tmux session above, so its leftover claude is now detached;
    // pane attribution spares every live sibling and the main session.
    try {
      reapDetachedChannelClaudes({ tmuxPath: TMUX })
    } catch (err) {
      logger.warn({ err, name }, 'pre-launch detached-claude reap failed (continuing)')
    }

    const model = readAgentModel(name)
    const authMode = readAgentAuthMode(name)
    const isClaude = model.startsWith('claude-')
    const isDeepseek = model.startsWith('deepseek-')
    const isOllama = !isClaude && !isDeepseek
    const ollamaEnv = isOllama ? `export ANTHROPIC_AUTH_TOKEN=ollama && export ANTHROPIC_BASE_URL=${OLLAMA_URL} && ` : ''
    const deepseekKey = isDeepseek ? (getSecret('DEEPSEEK_API_KEY') ?? '') : ''
    const deepseekEnv = isDeepseek ? `export ANTHROPIC_AUTH_TOKEN="${deepseekKey}" && export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic && ` : ''
    // When authMode is 'api', the agent uses its own ANTHROPIC_API_KEY from
    // the vault instead of the host's OAuth. The vault entry ID follows the
    // convention `agent-{name}-api-key`. We inject it as an env var so Claude
    // Code picks it up without needing OAuth credentials at all.
    let apiKeyEnv = ''
    if (isClaude && authMode === 'api') {
      const agentApiKey = getSecret(`agent-${name}-api-key`) ?? ''
      if (agentApiKey) {
        apiKeyEnv = `export ANTHROPIC_API_KEY="${agentApiKey}" && `
      }
    }
    // Apply security profile: write allow/deny list into settings.json, and
    // skip the dangerously-skip-permissions flag for strict profiles so
    // Claude Code enforces the list rather than bypassing it.
    const profile = loadProfileTemplate(readAgentSecurityProfile(name))
    writeAgentSettingsFromProfile(name, profile)
    // Channel-less agents must not load the global channel plugins from
    // enabledPlugins. Without this, they fall back to the main agent's
    // token and two instances fight over the same getUpdates slot (409
    // Conflict / orphan watchdog loop causing recurring MCP disconnects).
    if (!hasChannel) {
      const settingsPath = join(agentDir(name), '.claude', 'settings.json')
      try {
        const s = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
        s.enabledPlugins = {
          ...(s.enabledPlugins as Record<string, boolean> | undefined ?? {}),
          'telegram@claude-plugins-official': false,
          'slack-channel@marveen-marketplace': false,
          'discord@claude-plugins-official': false,
        }
        writeFileSync(settingsPath, JSON.stringify(s, null, 2))
      } catch (err) {
        logger.warn({ err, name }, 'Could not disable channel plugins for channel-less agent')
      }
    }
    const skipFlag = profile.permissionMode === 'strict' ? '' : '--dangerously-skip-permissions '
    // Per-agent CLAUDE_CONFIG_DIR. Every sub-agent gets an ISOLATED config dir
    // so it reads/writes its OWN .claude.json instead of contending on the
    // single shared ~/.claude.json file lock -- the WSL launch bug where the
    // freshly spawned claude lost the lock race and exited 1 silently within
    // ~1s. See agent-config-dir.ts.
    //
    // Resolution: if the operator pinned a CUSTOM config dir in agent-config
    // (i.e. one that is NOT the canonical .claude-config path -- used to route
    // an agent to a separate Anthropic login), respect it verbatim and do not
    // build over the operator's tree. Otherwise (field unset, or set to the
    // canonical path as for dave) auto-build the isolated dir.
    const explicitConfigDir = readAgentClaudeConfigDir(name)
    const canonicalConfigDir = join(agentDir(name), '.claude-config')
    let claudeConfigDir: string
    if (explicitConfigDir && explicitConfigDir !== canonicalConfigDir) {
      claudeConfigDir = explicitConfigDir
    } else {
      claudeConfigDir = ensureAgentConfigDir(name)
    }
    const claudeConfigEnv = `export CLAUDE_CONFIG_DIR="${claudeConfigDir}" && `
    // Fleet OAuth migration (PR #85 follow-up): shared-auth Claude agents
    // launched through the dashboard SOURCE the audited helper so the static
    // setup-token is exported as CLAUDE_CODE_OAUTH_TOKEN, which overrides a
    // stale symlinked .credentials.json -- closing the drift-discard / re-auth
    // outage class on the dashboard-launch path the bash watchdogs don't touch.
    // The token lands ONLY in the spawned shell's environ: it never enters this
    // process, the launch argv, or any log. Additive -- no-op when the helper or
    // token file is absent. own_team / api agents are excluded: they
    // authenticate off their own login or ANTHROPIC_API_KEY, not the shared token.
    const fleetOauthEnv =
      isClaude && authMode === 'shared' && existsSync(FLEET_OAUTH_HELPER)
        ? `export FLEET_ROOT="${PROJECT_ROOT}" && . "${FLEET_OAUTH_HELPER}" && `
        : ''
    // Per-agent dashboard token (card b1ce5118). Mint+persist this agent's token
    // file, then source the helper to export GENESIS_AGENT_TOKEN. Provisioning is
    // best-effort: a failure (DB/disk) must NEVER break a launch -- the agent
    // simply falls back to the shared bearer (fail-open for availability). The
    // raw token never enters this process; it is written 0600 and read only by
    // the sourced helper in the spawned shell.
    try {
      provisionAgentToken(getDb(), name, join(agentDir(name), '.genesis-token'))
    } catch (err) {
      logger.warn({ err, name }, 'Per-agent token provisioning failed; agent will use the shared bearer')
    }
    const agentTokenEnv = existsSync(AGENT_TOKEN_HELPER)
      ? `export FLEET_ROOT="${PROJECT_ROOT}" && export GENESIS_AGENT_ID="${name}" && . "${AGENT_TOKEN_HELPER}" && `
      : ''
    // `--continue` requires an existing session; on a brand-new agent the
    // Claude Code projects directory does not yet exist and `claude` exits
    // immediately with an obscure "No deferred tool marker found" error
    // that is silent inside tmux. Detect first launch by probing for the
    // encoded project dir and skip `--continue` only then. The encoding
    // mirrors Claude Code's own scheme: replace every `/` with `-`.
    // projects/ inside the isolated config dir is a symlink back to
    // ~/.claude/projects, so the encoded-cwd lookup still resolves to the
    // shared transcript store and --continue keeps working across restarts.
    const projectsRoot = join(claudeConfigDir, 'projects')
    const encodedProject = dir.replace(/\//g, '-')
    const hasPriorSession = existsSync(join(projectsRoot, encodedProject))
    const stateEnvVar = agentProvider === 'slack' ? 'SLACK_STATE_DIR' : agentProvider === 'discord' ? 'DISCORD_STATE_DIR' : 'TELEGRAM_STATE_DIR'
    const unsetTokens = 'unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN'
    // Slack plugin is third-party; its "not on approved allowlist" check is
    // bypassed via `allowedChannelPlugins` in /Library/Application Support/ClaudeCode/managed-settings.json.
    const auditLogEnv = agentProvider === 'slack' ? ` && export SLACK_AUDIT_LOG="${agentChannelDir}/audit.jsonl"` : ''
    const channelSetup = hasChannel
      ? `export ${stateEnvVar}="${agentChannelDir}"${auditLogEnv} && `
      : ''
    const channelFlag = hasChannel ? `--channels plugin:${provider.pluginId}` : ''
    // Single-quote `${model}` so values like `claude-opus-4-8[1m]` (1M-context
    // suffix) are not glob-expanded by the shell that tmux spawns the command in.
    // `continueFlag` is decided per-attempt (see shouldContinueSession): the
    // first attempt resumes, a liveness-window death falls back to a fresh boot.
    const buildLaunchCmd = (continueFlag: string): string =>
      `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH" && ${unsetTokens} && ${channelSetup}${apiKeyEnv}${claudeConfigEnv}${fleetOauthEnv}${agentTokenEnv}${ollamaEnv}${deepseekEnv}cd "${dir}" && ${CLAUDE} ${continueFlag}${skipFlag}--model '${model}' ${channelFlag}`.trimEnd()

    // `tmux new-session -d "cmd"` returns as soon as the SESSION exists, not
    // when the inner claude is up: if claude exits within ~1s (the silent
    // exit-1 on ~/.claude.json lock contention, now mitigated by the isolated
    // config dir above) the session is already gone by the time we return ok.
    // Probe liveness after a settle window and retry once so a one-off flake
    // -- which the node-spawned launch path showed but a direct shell did not
    // -- does not leave the dashboard reporting a started agent that died.
    let launched = false
    for (let attempt = 0; attempt < LAUNCH_MAX_ATTEMPTS; attempt++) {
      // opts.fresh (auto-restart 'fresh' mode) forces a brand-new conversation
      // on every attempt -- it drops the heavy accumulated context, so it must
      // override the attempt-0 resume that shouldContinueSession would grant.
      const useContinue = !opts.fresh && shouldContinueSession(hasPriorSession, attempt)
      const cmd = buildLaunchCmd(useContinue ? '--continue ' : '')
      // Pass `cmd` as a single execFileSync argv element, NOT interpolated into
      // a double-quoted execSync string. The launch command embeds its own
      // double quotes (cd "...", export X="...") and unexpanded $HOME/$PATH;
      // wrapping it in `"${cmd}"` for a shell makes the OUTER shell consume
      // those quotes and expand $PATH -- and on this WSL host $PATH contains
      // Windows entries with spaces ("/mnt/c/Program Files/..."), so the now-
      // unquoted value word-splits and tmux receives a shredded multi-arg
      // command that dies on launch (empty pane, agent stays DOWN -- the very
      // symptom this fix targets). execFileSync hands tmux the command verbatim
      // as one argument; tmux's own `sh -c` then parses the embedded quotes.
      execFileSync(TMUX, ['new-session', '-d', '-s', session, cmd], { timeout: 10000 })
      try { execSync(`sleep ${LAUNCH_LIVENESS_DELAY_S}`, { timeout: 5000 }) } catch { /* best effort */ }
      const decision = decideLaunchRetry(isAgentRunning(name), attempt, LAUNCH_MAX_ATTEMPTS - 1)
      if (decision === 'ok') { launched = true; break }
      if (decision === 'give-up') {
        logger.error({ name, session, attempts: attempt + 1 }, 'Agent session exited immediately after launch (gave up after retries)')
        return { ok: false, error: 'Agent process exited immediately after launch' }
      }
      // decision === 'retry': tear down the dead husk (in case a non-default
      // tmux remain-on-exit left a lingering shell) before the next attempt.
      // If this attempt used --continue, the next one drops it (shouldContinue-
      // Session returns false for attempt > 0): a stale deferred-tool marker in
      // the resumed transcript is the prime suspect, so we fall back to a fresh
      // boot rather than re-running the identical --continue command.
      logger.warn(
        { name, session, attempt, usedContinue: useContinue, nextIsFreshSession: useContinue },
        'Agent session died within liveness window, retrying launch (fresh session if --continue was used)',
      )
      try { execSync(`${TMUX} kill-session -t ${session} 2>/dev/null`, { timeout: 3000 }) } catch { /* ok */ }
      // Let the dead process release the config-dir lock before relaunching, so
      // the fallback launch does not lose the same lock race and silently die.
      try { execSync(`sleep ${LAUNCH_RETRY_SETTLE_S}`, { timeout: 5000 }) } catch { /* best effort */ }
    }
    if (!launched) return { ok: false, error: 'Agent process exited immediately after launch' }

    logger.info({ name, session, channelDir: agentChannelDir }, 'Agent tmux session started')

    // After a restart with --continue, a session that's been idle for >24h
    // shows the "Resume from summary" modal before the prompt input is ready
    // (113.6k tokens at 2d age in observed cases). Until the operator either
    // sends a new prompt or dismisses the modal, every scheduled task and
    // every inter-agent message stalls because isSessionReadyForPrompt sees
    // a non-idle pane state. The pre-flight dismiss baked into
    // sendPromptToSession only fires on outgoing traffic -- so on a fresh
    // restart with no inbound, the modal can sit indefinitely.
    //
    // Fire a delayed dismiss after Claude Code has had time to render the
    // modal. 8 seconds is a comfortable margin in observed restarts (modal
    // typically appears within 4-6s). Survey-rating modals from prior
    // sessions can also be present, so dismiss both. Errors are swallowed
    // -- the outbound pre-flight remains the safety net if this misses.
    scheduleIdentitySetup(session, readAgentDisplayName(name))

    return { ok: true }
  } catch (err) {
    logger.error({ err, name }, 'Failed to start agent tmux session')
    return { ok: false, error: 'Failed to start tmux session' }
  }
}

export function stopAgentProcess(name: string): { ok: boolean; error?: string } {
  const session = agentSessionName(name)
  if (!isAgentRunning(name)) return { ok: false, error: 'Agent is not running' }

  try {
    execSync(`${TMUX} kill-session -t ${session}`, { timeout: 5000 })
    execSync('sleep 2', { timeout: 4000 })
    // Reap any orphaned plugin grandchild that tmux did not tear down.
    // See channel-poller-reap.ts - the old pkill-by-env-var-on-cmdline did
    // not work because the env vars are not part of argv on macOS.
    try {
      const agentProvider = resolveAgentProvider(name)
      const dir = agentDir(name)
      reapChannelOrphans(agentProvider, dir)
    } catch (err) {
      logger.warn({ err, name }, 'post-stop channel-poller reap failed')
    }
    logger.info({ name, session }, 'Agent tmux session stopped')
    return { ok: true }
  } catch (err) {
    logger.error({ err, name, session }, 'Failed to stop agent tmux session')
    return { ok: false, error: 'Failed to stop tmux session' }
  }
}

export function getAgentProcessInfo(name: string): { running: boolean; session?: string } {
  const running = isAgentRunning(name)
  if (!running) return { running: false }
  return {
    running: true,
    session: agentSessionName(name),
  }
}

export function restartAgentProcess(name: string, opts: { fresh?: boolean } = {}): { ok: boolean; pid?: number; error?: string } {
  if (isAgentRunning(name)) {
    const stopResult = stopAgentProcess(name)
    if (!stopResult.ok) return { ok: false, error: stopResult.error || 'Failed to stop running agent before restart' }
  }
  return startAgentProcess(name, opts)
}

// Claude Code occasionally pops a "How is Claude doing this session? (optional)"
// rating modal above the prompt input. The footer line still reads
// "bypass permissions on (shift+tab to cycle)" so detectPaneState() classifies
// the pane as idle, but the modal swallows the next keystroke and pinches off
// every scheduled prompt + agent message until a human dismisses it. We strip
// it pre-flight by sending "0" (Dismiss) when the marker is visible, so any
// caller writing a prompt has a clear input field.
const SURVEY_MODAL_RX = /How is Claude doing this session/

function dismissSurveyModalIfPresent(session: string): void {
  try {
    const pane = execFileSync(TMUX, ['capture-pane', '-t', session, '-p'], { timeout: 3000, encoding: 'utf-8' })
    if (!SURVEY_MODAL_RX.test(pane)) return
    execFileSync(TMUX, ['send-keys', '-t', session, '0'], { timeout: 5000 })
    // Modal close is one frame; settle window so the next send-keys lands in
    // the prompt input, not the now-stale modal handler.
    execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 })
    logger.info({ session }, 'Dismissed Claude Code session-rating modal before sending prompt')
  } catch (err) {
    logger.warn({ err, session }, 'Failed to probe/dismiss session-rating modal')
  }
}

// When a session approaches its context limit Claude Code shows a "Resume from
// summary" modal with three numbered options and footer "Enter to confirm".
// detectPaneState() reads that footer as 'unknown' (not the usual "bypass
// permissions" string), so isSessionReadyForPrompt() refuses to deliver and
// every scheduled task / inter-agent message piles up behind it. Pre-flight
// pick option 1 (Resume from summary, recommended) and Enter to confirm.
const RESUME_SUMMARY_MODAL_RX = /Resume from summary/

export function dismissResumeSummaryModalIfPresent(session: string): void {
  try {
    const pane = execFileSync(TMUX, ['capture-pane', '-t', session, '-p'], { timeout: 3000, encoding: 'utf-8' })
    if (!RESUME_SUMMARY_MODAL_RX.test(pane)) return
    execFileSync(TMUX, ['send-keys', '-t', session, '1'], { timeout: 5000 })
    execFileSync('/bin/sleep', ['0.1'], { timeout: 2000 })
    execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    // /compact starts immediately and can run for minutes; we only need to
    // unblock the modal so detectPaneState can transition off 'unknown'.
    execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 })
    logger.info({ session }, 'Dismissed Claude Code resume-from-summary modal before sending prompt')
  } catch (err) {
    logger.warn({ err, session }, 'Failed to probe/dismiss resume-from-summary modal')
  }
}

// A6: the resume-from-summary modal does not always render within a single
// fixed window -- on a large/old session it can appear later than the one-shot
// dismiss above, and a missed dismiss leaves the next keystroke (/name) typed
// into the modal. Mirror the watchdog's answer_resume_prompt(): POLL the pane
// and press "1"+Enter the moment the menu appears, stopping early once the
// prompt is actually ready. Pure decision over a captured pane so the polling
// loop stays unit-testable.
export function decideResumeMenuAction(pane: string | null): 'dismiss' | 'ready' | 'wait' {
  if (pane == null) return 'wait'
  if (RESUME_SUMMARY_MODAL_RX.test(pane)) return 'dismiss'
  if (detectPaneState(pane) === 'idle') return 'ready'
  return 'wait'
}

const RESUME_WATCH_MAX_ATTEMPTS = 20
const RESUME_WATCH_POLL_MS = 2000

// Non-blocking resume-menu watcher: re-arms via setTimeout so it never blocks
// the event loop for the whole window (the server keeps serving). Presses
// "1"+Enter whenever the resume menu is visible and keeps polling until the
// prompt is ready or the attempt budget is exhausted, then invokes onSettled.
// Wired into scheduleIdentitySetup so EVERY launch (and every channel-monitor
// respawn) handles an old/big session's resume menu, not just dave's external
// watchdog. opts are injectable so the loop is testable without real timers.
export function scheduleResumeMenuWatch(
  session: string,
  onSettled: () => void,
  opts: { maxAttempts?: number; pollMs?: number } = {},
): void {
  const maxAttempts = opts.maxAttempts ?? RESUME_WATCH_MAX_ATTEMPTS
  const pollMs = opts.pollMs ?? RESUME_WATCH_POLL_MS
  let attempts = 0
  const tick = (): void => {
    let action: 'dismiss' | 'ready' | 'wait' = 'wait'
    try {
      action = decideResumeMenuAction(capturePane(session))
    } catch (err) {
      logger.warn({ err, session }, 'resume-menu watch: pane capture/decide failed')
    }
    if (action === 'dismiss') {
      try {
        execFileSync(TMUX, ['send-keys', '-t', session, '1'], { timeout: 5000 })
        execFileSync('/bin/sleep', ['0.1'], { timeout: 2000 })
        execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
        logger.info({ session }, 'resume-menu watch: answered resume-from-summary -> 1')
      } catch (err) {
        logger.warn({ err, session }, 'resume-menu watch: failed to send dismiss')
      }
      // Keep polling: confirm the menu cleared and the prompt becomes ready.
    } else if (action === 'ready') {
      onSettled()
      return
    }
    attempts++
    if (attempts >= maxAttempts) {
      onSettled()
      return
    }
    setTimeout(tick, pollMs)
  }
  setTimeout(tick, 0)
}

// Post-(re)start identity setup. Every freshly spawned Claude Code session is
// given `/name` so it is identifiable. (`/remote-control` was dropped: the
// operator no longer uses Remote Control, and the agent's inference-only OAuth
// token can't satisfy it anyway.) Pure helper for the exact slash commands so
// they are unit-tested; scheduleIdentitySetup wires them to tmux after a wait.
export function identitySlashCommands(displayName: string): string[] {
  return [`/name ${displayName}`]
}

// Delays mirror the observed Claude Code first-render timing: the first-run /
// resume modals appear within ~4-6s, so dismiss at 8s; the prompt input is
// reliably ready ~5s after that.
const MODAL_DISMISS_DELAY_MS = 8000
const IDENTITY_SEND_DELAY_MS = 5000
// Resume-menu poll cadence (A6): a large/old session can render the "Resume from
// summary" modal seconds AFTER launch -- well past the fixed MODAL_DISMISS_DELAY_MS
// one-shot, which then missed it and left the session wedged behind the modal.
// We poll (mirroring the watchdog answer_resume_prompt loop, now first-class in the
// launcher) until the modal is answered or the active prompt is up.
const RESUME_POLL_INTERVAL_MS = 2000
const RESUME_POLL_MAX_ATTEMPTS = 20 // ~40s window, matches the watchdog

// Pure: decide what the resume-menu poller should do for a captured pane.
//   'answer-resume' -- the "Resume from summary" modal is up; pick 1 + Enter
//   'ready'         -- the active prompt footer is up (detectPaneState idle); done
//   'wait'          -- neither yet; keep polling
// Resume takes precedence: if the modal is up we must answer it even if a stale
// footer is also visible in scrollback.
export function classifyResumePane(pane: string): 'answer-resume' | 'ready' | 'wait' {
  if (RESUME_SUMMARY_MODAL_RX.test(pane)) return 'answer-resume'
  if (detectPaneState(pane) === 'idle') return 'ready'
  return 'wait'
}

// Background, non-blocking, bounded poll that answers the resume-from-summary
// modal whenever it renders and resolves once the prompt is ready. Fire-and-
// forget (recursive setTimeout); errors are swallowed so a miss never tears down
// the caller. onReady fires on the active prompt or after the attempt budget.
function answerResumeMenuWhenReady(session: string, onReady: () => void, attempt = 0): void {
  if (attempt >= RESUME_POLL_MAX_ATTEMPTS) {
    logger.warn({ session, attempts: attempt }, 'resume-menu poll: neither modal nor active prompt within window; proceeding')
    onReady()
    return
  }
  let pane: string | null = null
  try {
    pane = execFileSync(TMUX, ['capture-pane', '-t', session, '-p'], { timeout: 3000, encoding: 'utf-8' })
  } catch {
    // session likely gone; nothing more to do
    onReady()
    return
  }
  const decision = classifyResumePane(pane)
  if (decision === 'ready') {
    if (attempt > 0) logger.info({ session, attempt }, 'resume-menu poll: active prompt ready')
    onReady()
    return
  }
  if (decision === 'answer-resume') {
    try {
      execFileSync(TMUX, ['send-keys', '-t', session, '1'], { timeout: 5000 })
      execFileSync('/bin/sleep', ['0.1'], { timeout: 2000 })
      execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
      logger.info({ session, attempt }, 'resume-menu poll: answered Resume-from-summary (1)')
    } catch (err) {
      logger.warn({ err, session }, 'resume-menu poll: answer send failed')
    }
    // keep polling: the modal -> /compact -> prompt transition takes a beat.
  }
  setTimeout(() => answerResumeMenuWhenReady(session, onReady, attempt + 1), RESUME_POLL_INTERVAL_MS)
}

// Schedule the identity setup for a freshly (re)spawned session: once it has
// had time to render, dismiss any first-run/resume modals, then send `/name`.
// Shared by startAgentProcess and the channel-monitor recovery respawns
// (resumeMarveenSession / respawnMarveenSessionFresh), which previously left the
// main session without its identity after auto-recovery. Fire-and-forget; all
// errors are swallowed/logged so a missed setup never tears down the caller.
export function scheduleIdentitySetup(session: string, displayName: string): void {
  setTimeout(() => {
    try {
      dismissSurveyModalIfPresent(session)
    } catch (err) {
      logger.warn({ err, session }, 'Post-restart survey-modal dismiss failed')
    }
    // A6: poll for the resume-from-summary menu (which can render late on a
    // large/old session, past the old fixed one-shot) and answer it, then send
    // identity once the prompt is actually ready -- not at a blind fixed delay.
    answerResumeMenuWhenReady(session, () => {
      setTimeout(() => {
        try {
          for (const cmd of identitySlashCommands(displayName)) {
            execFileSync(TMUX, ['send-keys', '-t', session, cmd, 'Enter'], { timeout: 5000 })
            execFileSync('/bin/sleep', ['1'], { timeout: 2000 })
          }
          logger.info({ session, displayName }, 'Set session /name')
        } catch (err) {
          logger.warn({ err, session, displayName }, 'Failed to set session /name')
        }
      }, IDENTITY_SEND_DELAY_MS)
    })
  }, MODAL_DISMISS_DELAY_MS)
}

// How many follow-up Enters sendPromptToSession() is willing to fire
// when the post-send capture says the prompt is still parked in the
// input box. Two retries cover the observed stuck-rate (single-pane
// recovery typically lands on the first or second extra Enter); a
// stuck-after-two-retries pane gets a logged give-up so the operator
// can intervene rather than the loop spinning indefinitely.
const SUBMIT_RETRY_MAX_ATTEMPTS = 2
// Wait between sending an Enter and re-capturing the pane. Long enough
// for tmux to flush the keystroke into the Claude Code TUI and for
// the TUI to either transition to busy (turn started) or stay idle
// with the parked text (still stuck). Empirically 300ms is past the
// frame-render gap detectPaneState already guards against.
const SUBMIT_RETRY_POLL_MS = '0.3'

// Buffer-clear (Ctrl-U) used pre-flight when shouldClearTruncatedPreamble
// flags a stale preamble. Sent as a single key name (no `-l` literal
// flag) so tmux interprets it as the control sequence.
function clearInputBuffer(session: string): void {
  try {
    execFileSync(TMUX, ['send-keys', '-t', session, 'C-u'], { timeout: 5000 })
    // Settle briefly so the next send-keys lands in the freshly cleared
    // buffer rather than racing the Ctrl-U.
    execFileSync('/bin/sleep', ['0.1'], { timeout: 2000 })
  } catch (err) {
    logger.warn({ err, session }, 'Failed to clear pane input buffer before send')
  }
}

// Send text to a tmux session as if typed at the prompt.
// Uses execFileSync so callers can pass raw text -- tmux send-keys -l treats
// the argument as literal characters, bypassing shell quoting entirely.
//
// Pre-flight: if the live input box already shows a stale preamble from
// a previous wrapped message that never fully landed (shouldClearTrun-
// catedPreamble), Ctrl-U the buffer first so a fresh prompt is not
// concatenated onto the stale trust-marker. Skipping this guard would
// let an UNTRUSTED payload sit behind a stale TEAM MEMBER NOTICE
// preamble and read as if it came from a trusted peer.
//
// Post-flight: bracketed-paste detection and frame-level races in the
// Claude Code TUI occasionally swallow the trailing Enter, leaving the
// fully written prompt parked in the input box (either as a [Pasted
// text #N] placeholder or as verbatim text under an idle footer). We
// re-sample the pane after the initial Enter and, if shouldRetrySubmit
// still reports stuck, send up to SUBMIT_RETRY_MAX_ATTEMPTS extra
// Enters. The retry budget bounds the loop so a pathologically stuck
// pane gives up rather than spinning.
export function sendPromptToSession(session: string, text: string): void {
  dismissSurveyModalIfPresent(session)
  dismissResumeSummaryModalIfPresent(session)

  // Pre-flight buffer-clear when a stale preamble is detected. Reading
  // the pane is best-effort: a capture failure here means we cannot
  // prove the buffer is clean, but proceeding without the clear is no
  // worse than the pre-fix status quo.
  try {
    const preCapture = execFileSync(TMUX, ['capture-pane', '-t', session, '-p'], { timeout: 3000, encoding: 'utf-8' })
    if (shouldClearTruncatedPreamble(preCapture)) {
      logger.info({ session }, 'Cleared stale preamble from input buffer before sending prompt')
      clearInputBuffer(session)
    }
  } catch (err) {
    logger.warn({ err, session }, 'Pre-send capture-pane failed; skipping truncated-preamble check')
  }

  const oneLine = text.replace(/\r?\n/g, ' ')
  const CHUNK = 80
  // tmux send-keys doesn't support `--` option-terminator, so a chunk that
  // starts with '-' parses as a flag ("command send-keys: unknown flag -s"
  // on Hungarian suffixes like -szal/-vel/-ban). Slide the boundary up to a
  // few chars past any '-' that lands at the start of the next chunk. Capped
  // so a long run of dashes doesn't inflate one chunk past the paste-detector
  // threshold; if the cap is reached, prepend a space to the chunk instead.
  const MAX_SLIDE = 8
  let i = 0
  while (i < oneLine.length) {
    let end = Math.min(i + CHUNK, oneLine.length)
    let slide = 0
    while (end < oneLine.length && oneLine[end] === '-' && slide < MAX_SLIDE) {
      end++; slide++
    }
    let chunk = oneLine.slice(i, end)
    if (chunk.startsWith('-')) chunk = ' ' + chunk
    execFileSync(TMUX, ['send-keys', '-t', session, '-l', chunk], { timeout: 5000 })
    i = end
    if (i < oneLine.length) execFileSync('/bin/sleep', ['0.03'], { timeout: 1000 })
  }
  execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })

  // Post-send retry loop. The payload hint is the first chunk of oneLine
  // (truncated to a safe length) so the verbatim-stuck path has something
  // recognisable to substring-match against without leaking the whole
  // prompt body into log lines should the give-up branch fire.
  const payloadHint = oneLine.slice(0, Math.min(oneLine.length, 96))
  for (let attempt = 0; ; attempt++) {
    try { execFileSync('/bin/sleep', [SUBMIT_RETRY_POLL_MS], { timeout: 2000 }) } catch { /* best effort */ }
    const pane = capturePane(session)
    const action = decideSubmitFollowup(pane, payloadHint, attempt, SUBMIT_RETRY_MAX_ATTEMPTS)
    if (action === 'done') break
    if (action === 'give-up') {
      logger.warn({ session, attempt }, 'sendPromptToSession: prompt still parked after retries')
      break
    }
    // action === 'retry-enter'
    try {
      execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    } catch (err) {
      logger.warn({ err, session, attempt }, 'Retry-Enter send failed')
      break
    }
  }
}

// How long to wait between the two capture samples when the first one
// looks idle. The Claude Code UI renders the "idle footer without `esc
// to interrupt`" line for ~1 frame after a turn submits before the
// spinner lands; a quarter-second settle window is well past that.
const PANE_READY_CONFIRM_DELAY_S = '0.25'

// Send a bare Enter to a session. Used by the stuck-input watcher to
// re-submit a prompt whose trailing Enter was swallowed on the channel-
// notification path (where the plugin, not sendPromptToSession, delivered
// the text, so the post-send retry budget never ran). Best-effort: a
// tmux failure is logged and swallowed so the watcher loop keeps going.
export function sendEnterToSession(session: string): boolean {
  try {
    execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    return true
  } catch (err) {
    logger.warn({ err, session }, 'sendEnterToSession: failed to send recovery Enter')
    return false
  }
}

// Send a bare Escape to a session: the soft-interrupt primitive behind the
// dashboard "interrupt this agent" action. Escape is Claude Code's cancel-the-
// current-turn key, the gentle rung between an operator nudge and a kill+restart
// (card b83e7c92). No text is typed -- this only sends the control key -- so
// there is nothing operator-supplied to sanitise. Best-effort: a tmux failure
// is logged and swallowed, mirroring sendEnterToSession.
export function sendEscapeToSession(session: string): boolean {
  try {
    execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 5000 })
    return true
  } catch (err) {
    logger.warn({ err, session }, 'sendEscapeToSession: failed to send interrupt Escape')
    return false
  }
}

// Capture a pane snapshot with an execFileSync timeout. Null on any error so
// the caller can treat "capture failed" as "not ready".
export function capturePane(session: string): string | null {
  try {
    return execFileSync(TMUX, ['capture-pane', '-t', session, '-p'], { timeout: 3000, encoding: 'utf-8' })
  } catch {
    return null
  }
}

// Check if a Claude Code tmux session is ready to accept a new prompt.
//
// The detection has two layers, both needed to close the frame-level
// false-positive that let PR1+PR2's smoke test fire a prompt into a pane
// that was actually mid-thinking:
//
//   1. detectPaneState() looks for a set of turn-scoped busy signals
//      (spinner glyph labels paired with the runtime tail, token-count
//      pattern, and the footer's `esc to interrupt` marker) so even the
//      single frame where the footer lacks `· esc to interrupt` is
//      classified busy by the spinner that is already rendered above
//      the input box.
//
//   2. Double-sample confirmation: if the first capture looks idle, we
//      sleep 250ms and re-capture. Only agreement from both samples
//      returns true. Cost on the ready path: ~250ms sleep plus a second
//      tmux capture-pane round-trip (typically tens of ms). Busy pass
//      through layer 1 and return immediately without the delay.
export function isSessionReadyForPrompt(session: string): boolean {
  const first = capturePane(session)
  if (first == null) return false
  if (detectPaneState(first) !== 'idle') return false

  try { execFileSync('/bin/sleep', [PANE_READY_CONFIRM_DELAY_S], { timeout: 2000 }) } catch { /* best effort */ }

  const second = capturePane(session)
  if (second == null) return false
  return detectPaneState(second) === 'idle'
}

