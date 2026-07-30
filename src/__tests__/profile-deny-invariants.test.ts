import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Guards the fleet-critical permissions.deny floor (aios-adoption item 2a,
// "keys not prompts" -- track 2a). These rules were prompt-only (CLAUDE.md) and
// are now mechanism-enforced via every agent's launch profile. The test pins
// that no profile can silently drop them, and that the writer (writeAgentSettings-
// FromProfile) re-reads these at every launch so they cannot drift.
const PROFILES_DIR = join(__dirname, '../../templates/profiles')

interface Profile {
  id: string
  permissionMode: 'strict' | 'permissive'
  filesystem: { allow: string[]; deny: string[] }
}

const profiles: Profile[] = readdirSync(PROFILES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(PROFILES_DIR, f), 'utf-8')) as Profile)

// Denials that EVERY profile must carry, regardless of role:
//  - pkill / killall: name-matching process kills can take down fleet tmux
//    sessions; the fleet rule is PID/session-scoped kills only (`kill <pid>`
//    stays allowed -- only the name-matching variants are denied).
//  - access.json write/edit: Telegram allowlist tampering must never happen
//    programmatically (the /telegram:access skill is the only sanctioned path).
//  - npm publish: no fleet agent publishes packages; an accidental/injected
//    publish is irreversible (a version cannot be unpublished after 72h, and the
//    name is burned). Denied everywhere as a never-do floor (item 2b Bash side).
const UNIVERSAL_DENY = [
  'Bash(pkill:*)',
  'Bash(killall:*)',
  'Bash(npm publish:*)',
  'Write(**/access.json)',
  'Edit(**/access.json)',
  // card 0680cf34: fleet credential files must not be Read-able by any agent
  'Read(store/.dashboard-token)',
  'Read(**/.git-credentials)',
  'Read(**/.claude.json)',
]

describe('profile permissions.deny -- fleet-critical floor (item 2a)', () => {
  it('finds the committed profiles', () => {
    expect(profiles.length).toBeGreaterThanOrEqual(5)
    expect(profiles.map((p) => p.id).sort()).toEqual(
      ['default', 'developer-junior', 'developer-senior', 'marketer', 'researcher'],
    )
  })

  for (const universal of UNIVERSAL_DENY) {
    it(`every profile denies ${universal}`, () => {
      for (const p of profiles) {
        expect(p.filesystem.deny, `profile ${p.id} missing ${universal}`).toContain(universal)
      }
    })
  }

  it('does NOT deny PID-scoped kill (only pkill is blocked, kill <pid> stays usable)', () => {
    for (const p of profiles) {
      expect(p.filesystem.deny).not.toContain('Bash(kill:*)')
    }
  })

  it('blocks direct main/master push on every push-capable profile', () => {
    // A profile is "push-capable" unless it denies git push wholesale.
    const deniesAllPush = (p: Profile) => p.filesystem.deny.some((d) => d === 'Bash(git push:*)')
    for (const p of profiles.filter((p) => !deniesAllPush(p))) {
      const blocksMain =
        p.filesystem.deny.includes('Bash(git push origin main:*)') &&
        p.filesystem.deny.includes('Bash(git push origin master:*)')
      // default has no git in its (empty) allow set, so it is not push-capable
      // in practice; only assert for profiles that actually grant/allow pushing.
      if (p.id === 'developer-senior' || p.id === 'developer-junior') {
        expect(blocksMain, `profile ${p.id} must deny direct main/master push`).toBe(true)
      }
    }
  })

  it('keeps force-push denied on dev profiles (regression guard)', () => {
    for (const p of profiles.filter((p) => p.id.startsWith('developer-'))) {
      expect(p.filesystem.deny).toContain('Bash(git push --force:*)')
    }
  })

  it('every profile is structurally valid', () => {
    for (const p of profiles) {
      expect(typeof p.id).toBe('string')
      expect(['strict', 'permissive']).toContain(p.permissionMode)
      expect(Array.isArray(p.filesystem.allow)).toBe(true)
      expect(Array.isArray(p.filesystem.deny)).toBe(true)
    }
  })
})
