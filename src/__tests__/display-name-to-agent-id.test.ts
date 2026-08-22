import { describe, it, expect } from 'vitest'
import { displayNameToAgentId } from '../web/agent-config.js'

// displayNameToAgentId is the REVERSE of readAgentDisplayName: it resolves a
// Boss-typed name ("NoA", "Grace") -- or a raw agent id ("dave") -- back to the
// internal agent id, for the OPS-151 launch/route alias. The roster and the
// display resolver are injected so the logic is testable without the filesystem
// (mirrors normalizeRecipient's isKnown seam).
//
// Failure policy is FAIL-CLOSED (opposite of the Boss-facing text guard): this
// feeds a launch/route action, so an ambiguous name must REFUSE (null), never
// guess -- a wrong resolution would spawn/address the WRONG agent.

const roster = ['marveen', 'radar', 'gauge', 'dave']
const display: Record<string, string> = {
  marveen: 'NoA',
  radar: 'Grace',
  gauge: 'Dampier',
  dave: 'Dave',
}
const resolve = (id: string) => display[id] ?? id.charAt(0).toUpperCase() + id.slice(1)

describe('displayNameToAgentId', () => {
  it('resolves a display name to its agent id, case-insensitively', () => {
    expect(displayNameToAgentId('NoA', roster, resolve)).toBe('marveen')
    expect(displayNameToAgentId('noa', roster, resolve)).toBe('marveen')
    expect(displayNameToAgentId('NOA', roster, resolve)).toBe('marveen') // Boss typo on Telegram
    expect(displayNameToAgentId('Grace', roster, resolve)).toBe('radar')
    expect(displayNameToAgentId('Dampier', roster, resolve)).toBe('gauge')
  })

  it('resolves a raw agent id to itself (superset of is-known-id)', () => {
    expect(displayNameToAgentId('dave', roster, resolve)).toBe('dave')
    expect(displayNameToAgentId('MARVEEN', roster, resolve)).toBe('marveen')
  })

  it('trims surrounding whitespace', () => {
    expect(displayNameToAgentId('  NoA  ', roster, resolve)).toBe('marveen')
  })

  it('returns null for an unknown name', () => {
    expect(displayNameToAgentId('nobody', roster, resolve)).toBeNull()
  })

  it('returns null for empty / whitespace-only input', () => {
    expect(displayNameToAgentId('', roster, resolve)).toBeNull()
    expect(displayNameToAgentId('   ', roster, resolve)).toBeNull()
  })

  it('fails CLOSED when two agents share a display name (ambiguous)', () => {
    const dup = ['a', 'b']
    const dupResolve = (_id: string) => 'Twin'
    expect(displayNameToAgentId('Twin', dup, dupResolve)).toBeNull()
  })

  it('fails CLOSED when one agent display collides with another agent id', () => {
    // 'grace' is an agent id here, and radar's display is also 'Grace' -> the
    // key "grace" is ambiguous, so it must refuse rather than pick one.
    const r = ['grace', 'radar']
    const res = (id: string) => (id === 'radar' ? 'Grace' : 'Graceful')
    expect(displayNameToAgentId('grace', r, res)).toBeNull()
  })

  it("does not treat an agent's own id+display as a self-collision", () => {
    // dave's id is 'dave' and display is 'Dave' -> same id both ways, NOT ambiguous.
    expect(displayNameToAgentId('dave', roster, resolve)).toBe('dave')
    expect(displayNameToAgentId('Dave', roster, resolve)).toBe('dave')
  })
})
