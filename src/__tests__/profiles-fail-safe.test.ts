import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertKnownProfile,
  knownProfileIds,
  loadProfileTemplate,
  profileExists,
  HARDCODED_RESTRICTIVE_PROFILE,
} from '../web/profiles.js'
import { writeAgentSecurityProfile } from '../web/agent-config.js'
import { logger } from '../logger.js'

// SEC-098: an unknown securityProfile (a typo, or a profile removed from
// templates/profiles/) used to fall back to the permissive default.json with NO
// signal -- a fail-OPEN security control (found via PR#773: InkWell's non-existent
// "developer-mid" silently downgraded the agent to permissive). PR-1 added loud
// logging. PR-2 (this file's additions): flips the runtime fallback from permissive
// default to HARDCODED_RESTRICTIVE_PROFILE (strict + deny-all), so a misconfigured
// channel-less agent is locked out rather than silently running permissive.
const KNOWN = ['default', 'developer-junior', 'developer-senior', 'heartbeat', 'marketer', 'researcher', 'restricted-fallback']

afterEach(() => {
  vi.restoreAllMocks()
})

describe('profiles -- known-profile introspection', () => {
  it('knownProfileIds returns exactly the committed profiles', () => {
    expect(knownProfileIds()).toEqual([...KNOWN].sort())
  })

  it('profileExists is true for every committed profile', () => {
    for (const id of KNOWN) expect(profileExists(id)).toBe(true)
  })

  it('profileExists is false for an unknown or empty id', () => {
    expect(profileExists('developer-mid')).toBe(false) // the PR#773 typo
    expect(profileExists('standard')).toBe(false) // the heartbeat/buster typo
    expect(profileExists('')).toBe(false)
    expect(profileExists(undefined as unknown as string)).toBe(false)
  })
})

describe('profiles -- assertKnownProfile (fail-loud for write paths)', () => {
  it('does not throw for a known profile', () => {
    expect(() => assertKnownProfile('researcher')).not.toThrow()
  })

  it('throws for an unknown profile, naming the bad id and the known set', () => {
    expect(() => assertKnownProfile('developer-mid')).toThrow(/developer-mid/)
    expect(() => assertKnownProfile('developer-mid')).toThrow(/researcher/)
  })
})

describe('profiles -- loadProfileTemplate fail-safe (not silent fail-open)', () => {
  it('returns the requested profile when it exists', () => {
    const p = loadProfileTemplate('developer-senior')
    expect(p.id).toBe('developer-senior')
  })

  it('an unknown profile logs an error (no more SILENT fallback)', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    loadProfileTemplate('developer-mid')
    expect(spy).toHaveBeenCalledTimes(1)
    // the log payload must carry the offending profile id for the operator
    const [payload] = spy.mock.calls[0] as [Record<string, unknown>, string]
    expect(payload.requestedProfile).toBe('developer-mid')
  })

  it('SEC-098 PR-2: unknown id returns restricted-fallback (fail-SAFE, not permissive default)', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const p = loadProfileTemplate('totally-made-up')
    expect(p.id).toBe('restricted-fallback')
    expect(p.permissionMode).toBe('strict')
  })

  it('restricted-fallback has non-empty deny list covering Bash(*)', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const p = loadProfileTemplate('totally-made-up')
    expect(p.filesystem.allow).toEqual([])
    expect(p.filesystem.deny).toContain('Bash(*)')
    expect(p.filesystem.deny).toContain('Write(*)')
    expect(p.filesystem.deny).toContain('Read(*)')
  })

  it('does NOT log when the default profile itself is requested', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    loadProfileTemplate('default')
    expect(spy).not.toHaveBeenCalled()
  })

  it('does NOT log when restricted-fallback is requested directly', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const p = loadProfileTemplate('restricted-fallback')
    expect(spy).not.toHaveBeenCalled()
    expect(p.id).toBe('restricted-fallback')
  })
})

describe('HARDCODED_RESTRICTIVE_PROFILE -- in-code fail-safe constant (SEC-098 PR-2)', () => {
  it('is strict + deny-all for the main tool types', () => {
    expect(HARDCODED_RESTRICTIVE_PROFILE.permissionMode).toBe('strict')
    expect(HARDCODED_RESTRICTIVE_PROFILE.filesystem.allow).toEqual([])
    for (const tool of ['Bash(*)', 'Write(*)', 'Edit(*)', 'Read(*)']) {
      expect(HARDCODED_RESTRICTIVE_PROFILE.filesystem.deny).toContain(tool)
    }
  })

  it('carries UNIVERSAL_DENY entries as defense-in-depth', () => {
    const deny = HARDCODED_RESTRICTIVE_PROFILE.filesystem.deny
    expect(deny).toContain('Bash(pkill:*)')
    expect(deny).toContain('Write(**/access.json)')
    expect(deny).toContain('Read(**/.dashboard-token)')
  })
})

describe('writeAgentSecurityProfile -- fail-loud write guard', () => {
  // The assertion fires BEFORE any fs access, so an unknown profile is rejected
  // without creating or half-writing an agent-config.json (no cleanup needed;
  // the agent name below never touches disk).
  it('throws on an unknown profile instead of persisting a fail-open value', () => {
    expect(() => writeAgentSecurityProfile('__sec098_nonexistent_agent__', 'developer-mid'))
      .toThrow(/Unknown securityProfile/)
  })
})
