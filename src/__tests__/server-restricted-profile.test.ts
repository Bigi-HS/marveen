import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OUTWARD_DESTRUCTIVE_DENY,
  PROFILES_DIR,
  knownProfileIds,
  loadProfileTemplate,
  profileExists,
} from '../web/profiles.js'

// Card 2efcb439 §10 -- server-side write-block profile. The always-on server /
// heartbeat agents must have the outward-acting + destructive tool class
// (send / share / delete / publish) DENIED at the tool-permission layer
// (settings.json), NOT merely asked-for in CLAUDE.md prose. The enforcement path
// is: profile.filesystem.deny -> agent .claude/settings.json (agent-scaffold.ts)
// -> Claude Code's permissions engine. An explicit deny is enforced even in
// permissive mode (see templates/profiles/default.json: "a deny-lista ... még
// permissive módban is [tilt]") -- --dangerously-skip-permissions auto-approves
// the ASK prompts, it does NOT override an explicit deny rule. So this profile is
// PERMISSIVE (like every working fleet profile) to avoid prompt-hang on a
// channel-less background agent, while the deny list still blocks the dangerous
// class.
//
// This slice (1) commits the `server-restricted` profile and (2) asserts, at the
// config layer, that it denies the whole outward/destructive class while staying
// usable for monitoring. The launch-time exit-code falsification (a server-profile
// agent's outbound send returns a permission-deny) is a follow-up integration slice.

function defaultDeny(): string[] {
  const p = JSON.parse(readFileSync(join(PROFILES_DIR, 'default.json'), 'utf-8'))
  return p.filesystem.deny as string[]
}

describe('server-restricted profile -- §10 server-side write-block', () => {
  it('is a committed, known profile', () => {
    expect(profileExists('server-restricted')).toBe(true)
    expect(knownProfileIds()).toContain('server-restricted')
  })

  it('is permissive so a channel-less background agent does not prompt-hang', () => {
    // A strict profile drops --dangerously-skip-permissions for a channel-less
    // agent (computeSkipFlag), which would make every non-allow-listed tool call
    // block on an unanswerable prompt. The deny list is enforced regardless of
    // mode, so permissive + deny is the correct, functional combination.
    const p = loadProfileTemplate('server-restricted')
    expect(p.id).toBe('server-restricted')
    expect(p.permissionMode).toBe('permissive')
  })

  it('denies every pattern in the outward/destructive class (falsifying test)', () => {
    const deny = loadProfileTemplate('server-restricted').filesystem.deny
    // The profile must be a SUPERSET of the canonical outward/destructive class.
    for (const pat of OUTWARD_DESTRUCTIVE_DENY) {
      expect(deny).toContain(pat)
    }
  })

  it('denies at least one representative of each send/share/delete/publish axis', () => {
    const deny = loadProfileTemplate('server-restricted').filesystem.deny
    const hasAxis = (needles: string[]) =>
      needles.some(n => deny.some(d => d.includes(n)))
    expect(hasAxis(['telegram', 'slack', 'discord', 'notify'])).toBe(true) // send
    expect(hasAxis(['WebFetch'])).toBe(true) // share / egress
    expect(hasAxis(['rm', 'pkill', 'killall'])).toBe(true) // delete / destructive
    expect(hasAxis(['git push', 'npm publish', 'gh'])).toBe(true) // publish
  })

  it('is at least as strict as the default profile on the irreversible baseline', () => {
    // server-restricted must never be WEAKER than `default` on the fleet-critical
    // irreversible ops (pkill/killall, access.json forgery, token/credential reads,
    // self-rewrite of settings/mcp). It only ever ADDS to that baseline.
    const deny = loadProfileTemplate('server-restricted').filesystem.deny
    for (const pat of defaultDeny()) {
      expect(deny).toContain(pat)
    }
  })

  it('is surgical, not deny-all -- the server agent can still read & monitor locally', () => {
    const deny = loadProfileTemplate('server-restricted').filesystem.deny
    // A deny-all profile (like restricted-fallback) would block Read/local Bash and
    // make a monitoring agent useless. server-restricted must NOT blanket-deny them.
    expect(deny).not.toContain('Read(*)')
    expect(deny).not.toContain('Bash(*)')
  })

  it('OUTWARD_DESTRUCTIVE_DENY covers all four axes and has no duplicates', () => {
    expect(OUTWARD_DESTRUCTIVE_DENY.length).toBeGreaterThan(0)
    expect(new Set(OUTWARD_DESTRUCTIVE_DENY).size).toBe(OUTWARD_DESTRUCTIVE_DENY.length)
  })
})
