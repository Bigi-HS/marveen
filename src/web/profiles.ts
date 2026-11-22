import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'

// Each profile is a JSON file under templates/profiles/ with an allow/deny
// list that Claude Code's native permissions engine understands. Choosing a
// strict profile also drops --dangerously-skip-permissions, so Claude Code
// enforces the allow/deny list rather than bypassing it -- but ONLY for a
// channel-less agent (see computeSkipFlag). A channel agent keeps the bypass:
// an interactive permission prompt has no usable surface on Telegram/Slack and
// leaks the raw prompt into the chat after a restart while the callback stalls.
export interface ProfileTemplate {
  id: string
  label: string
  description: string
  permissionMode: 'strict' | 'permissive'
  filesystem: { allow: string[]; deny: string[] }
}

export const PROFILES_DIR = join(PROJECT_ROOT, 'templates', 'profiles')

export const HARDCODED_DEFAULT_PROFILE: ProfileTemplate = {
  id: 'default',
  label: 'Alapértelmezett',
  description: 'Permissive fallback.',
  permissionMode: 'permissive',
  filesystem: { allow: [], deny: [] },
}

// SEC-098 PR-2: most-restrictive in-code constant used when an unknown/corrupt
// securityProfile is encountered at agent launch. Strict mode + deny-all for the
// main tool types so a misconfigured agent cannot make progress until its profile
// is corrected. The corresponding templates/profiles/restricted-fallback.json
// carries the full deny list (incl. UNIVERSAL_DENY entries); this in-code copy
// is the emergency constant when that file is itself missing or corrupt.
export const HARDCODED_RESTRICTIVE_PROFILE: ProfileTemplate = {
  id: 'restricted-fallback',
  label: 'Korlátozó visszaállás',
  description: 'Ismeretlen securityProfile esetén alkalmazott legkisebb jogosultságú profil.',
  permissionMode: 'strict',
  filesystem: {
    allow: [],
    deny: [
      'Bash(*)', 'Write(*)', 'Edit(*)', 'Read(*)', 'WebFetch(*)', 'WebSearch(*)',
      'Bash(pkill:*)', 'Bash(killall:*)', 'Bash(npm publish:*)',
      'Write(**/access.json)', 'Edit(**/access.json)',
      'Read(**/.dashboard-token)', 'Read(**/.git-credentials)', 'Read(**/.claude.json)',
      'Write(**/.mcp.json)', 'Edit(**/.mcp.json)',
      'Write(**/settings.json)', 'Edit(**/settings.json)',
    ],
  },
}

// Card 2efcb439 §10 -- the outward-acting + destructive tool class. An always-on
// server / heartbeat agent must have this whole class DENIED at the permission
// layer (not asked-for in prose). Grouped by axis:
//   send    -- outbound messaging to a human/channel
//   share   -- data egress off the box
//   delete  -- irreversible destruction of processes / data
//   publish -- releasing code/artifacts outward
// The committed templates/profiles/server-restricted.json carries this list (plus
// the default irreversible baseline); this constant is the single source of truth
// the profile is tested against, so dropping an axis from the JSON fails the suite.
export const OUTWARD_DESTRUCTIVE_DENY: string[] = [
  // send -- EVERY MCP integration tool (channels, email, external services).
  // Blanket mcp__* is deliberate and fail-CLOSED: the real installed namespace
  // is plugin-prefixed (mcp__plugin_telegram_telegram__reply,
  // mcp__<agent>_google__gmail_send), NOT the short mcp__telegram__ form, so a
  // per-channel enumerated deny silently fails OPEN when the namespace format
  // drifts (Chad #1057 HIGH). A server/heartbeat monitor needs no MCP tool at
  // all (it reads the board/logs via Bash + the local api-get helper), so the
  // whole class is denied; the confirmed Boss channel is also listed explicitly
  // as belt-and-suspenders documentation.
  'mcp__*',
  'mcp__plugin_telegram_telegram__*',
  // share -- data leaving the box. WebFetch + wget are pure external fetch/egress
  // and are denied outright. KNOWN GAP (Chad #1057 F-2, closed in §10 slice-2):
  // `Bash(curl ...)` external POST can still exfiltrate, but a static glob cannot
  // separate external curl from the LEGITIMATE localhost api-get monitoring
  // (http://127.0.0.1:3420) the server agent relies on -- a blind Bash(curl:*)
  // deny would break monitoring, and `curl *http*` catches localhost too. The
  // external-vs-localhost egress policy belongs in slice-2's launch-time
  // enforcement (a wrapper/egress-proxy that can inspect the target host), not in
  // a pattern that only looks complete. Documented, not silently dropped.
  'WebFetch(*)',
  'Bash(wget:*)',
  // delete -- irreversible destruction
  'Bash(rm:*)',
  'Bash(pkill:*)',
  'Bash(killall:*)',
  'Bash(dropdb:*)',
  // publish -- releasing code/artifacts outward
  'Bash(git push:*)',
  'Bash(npm publish:*)',
  'Bash(gh:*)',
]

export function listProfileTemplates(): ProfileTemplate[] {
  if (!existsSync(PROFILES_DIR)) return [HARDCODED_DEFAULT_PROFILE]
  const out: ProfileTemplate[] = []
  for (const f of readdirSync(PROFILES_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const p = JSON.parse(readFileSync(join(PROFILES_DIR, f), 'utf-8')) as ProfileTemplate
      if (p.id) out.push(p)
    } catch { /* skip malformed */ }
  }
  return out.length ? out : [HARDCODED_DEFAULT_PROFILE]
}

// The ids of every profile that actually exists under templates/profiles/
// (plus the hardcoded default when the directory is absent). This is the
// authoritative set a securityProfile value must belong to.
export function knownProfileIds(): string[] {
  return listProfileTemplates().map(p => p.id).sort()
}

// True iff `id` names a profile that actually exists. Cheap introspection used
// by the write paths (agent create, /security PUT) to reject a bad profile up
// front rather than persisting a fail-open value.
export function profileExists(id: string): boolean {
  if (typeof id !== 'string' || !id) return false
  return knownProfileIds().includes(id)
}

// Fail-LOUD guard for WRITE paths (SEC-098). A securityProfile is only ever
// persisted through this assertion, so a typo or a removed profile is rejected
// at the boundary instead of silently downgrading the agent to permissive.
export function assertKnownProfile(id: string): void {
  if (!profileExists(id)) {
    throw new Error(`Unknown securityProfile "${id}". Known profiles: ${knownProfileIds().join(', ')}`)
  }
}

// Read the on-disk `default` profile, or the hardcoded permissive fallback when
// templates/profiles/default.json is missing/corrupt.
function loadDefaultProfile(): ProfileTemplate {
  const path = join(PROFILES_DIR, 'default.json')
  if (existsSync(path)) {
    try {
      const p = JSON.parse(readFileSync(path, 'utf-8')) as ProfileTemplate
      if (p && p.id) return p
    } catch { /* fall through to the hardcoded default */ }
  }
  return HARDCODED_DEFAULT_PROFILE
}

export function loadProfileTemplate(id: string): ProfileTemplate {
  const path = join(PROFILES_DIR, `${id}.json`)
  if (existsSync(path)) {
    try {
      const p = JSON.parse(readFileSync(path, 'utf-8')) as ProfileTemplate
      if (p && p.id) return p
    } catch { /* corrupt file -- fall through to the fail-safe below */ }
  }
  // SEC-098 PR-2 (fail-SAFE flip): an unknown/removed/corrupt profile now falls
  // back to HARDCODED_RESTRICTIVE_PROFILE (strict + deny-all) instead of the
  // permissive default. This means a misconfigured channel-less agent is LOCKED
  // OUT rather than silently running permissive -- the correct trade-off once
  // every live agent-config is validated (all configs valid since PR#776+#777+#778).
  //
  // Exception: requesting 'default' explicitly still resolves normally (the
  // default profile is always valid and loading it should never log an error).
  if (id === HARDCODED_DEFAULT_PROFILE.id) {
    return loadDefaultProfile()
  }
  logger.error(
    { requestedProfile: id, knownProfiles: knownProfileIds() },
    'securityProfile not found -- falling back to restricted-fallback (FAIL-SAFE; fix the agent-config, SEC-098)',
  )
  // Try to load restricted-fallback from disk; if that too is missing, use the
  // in-code constant so the fleet never silently goes permissive.
  const rfPath = join(PROFILES_DIR, 'restricted-fallback.json')
  if (existsSync(rfPath)) {
    try {
      const rf = JSON.parse(readFileSync(rfPath, 'utf-8')) as ProfileTemplate
      if (rf && rf.id) return rf
    } catch { /* fall through to the in-code constant */ }
  }
  return HARDCODED_RESTRICTIVE_PROFILE
}

// Decide whether a launched agent gets --dangerously-skip-permissions. A strict
// profile drops the flag so Claude Code enforces the allow/deny list -- but a
// channel agent (Telegram/Slack/Discord) MUST keep the bypass regardless of
// profile: an interactive permission prompt cannot be answered on the channel,
// so it leaks into the chat on restart and the callback stalls (Boss complaint,
// card af398086/b407711f). The flag is therefore dropped ONLY for a strict
// profile with no channel. Returns the flag WITH its trailing space, or ''.
export function computeSkipFlag(permissionMode: ProfileTemplate['permissionMode'], hasChannel: boolean): string {
  return permissionMode === 'strict' && !hasChannel ? '' : '--dangerously-skip-permissions '
}

export function resolveProfilePlaceholders(value: string, ctx: { HOME: string; AGENT_DIR: string }): string {
  return value
    .replace(/\$\{HOME\}/g, ctx.HOME)
    .replace(/\$\{AGENT_DIR\}/g, ctx.AGENT_DIR)
    .replace(/\$\{WORKDIR\}/g, ctx.AGENT_DIR)
}
