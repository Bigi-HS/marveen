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
  // SEC-098: an unknown/removed/corrupt profile must NOT fall back SILENTLY to
  // the permissive default -- that is fail-open (a typo or a removed profile
  // downgrades the agent to permissive with no signal; found via PR#773 InkWell
  // "developer-mid"). Log LOUDLY so the operator sees the misconfiguration.
  // (The runtime fallback still returns the permissive default here so a single
  // bad config cannot brick a channel-less agent; flipping this to a MOST-
  // RESTRICTIVE fail-safe profile is the follow-up hardening, gated on every
  // live agent-config being validated first -- otherwise agents currently
  // running on an invalid profile would be locked out at their next launch.)
  if (id !== HARDCODED_DEFAULT_PROFILE.id) {
    logger.error(
      { requestedProfile: id, knownProfiles: knownProfileIds() },
      'securityProfile not found -- falling back to permissive default (FAIL-OPEN; fix the agent-config, SEC-098)',
    )
  }
  return loadDefaultProfile()
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
