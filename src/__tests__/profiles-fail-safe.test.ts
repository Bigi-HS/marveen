import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertKnownProfile,
  knownProfileIds,
  loadProfileTemplate,
  profileExists,
} from '../web/profiles.js'
import { writeAgentSecurityProfile } from '../web/agent-config.js'
import { logger } from '../logger.js'

// SEC-098: an unknown securityProfile (a typo, or a profile removed from
// templates/profiles/) used to fall back to the permissive default.json with NO
// signal -- a fail-OPEN security control (found via PR#773: InkWell's non-existent
// "developer-mid" silently downgraded the agent to permissive). These tests pin:
//   1. the loader still returns a usable profile on an unknown id (no crash), but
//   2. it now logs LOUDLY instead of silently swallowing the misconfiguration, and
//   3. a reusable validator (profileExists / assertKnownProfile) exists so WRITE
//      paths (agent create, /security PUT) can reject a bad profile up front.
const KNOWN = ['default', 'developer-junior', 'developer-senior', 'marketer', 'researcher']

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

  it('still returns a usable (permissive default) profile on an unknown id -- no crash', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const p = loadProfileTemplate('totally-made-up')
    expect(p.id).toBe('default')
    expect(p.permissionMode).toBe('permissive')
  })

  it('does NOT log when the default profile itself is requested', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    loadProfileTemplate('default')
    expect(spy).not.toHaveBeenCalled()
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
