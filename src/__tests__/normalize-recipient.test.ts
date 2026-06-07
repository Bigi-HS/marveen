import { describe, it, expect } from 'vitest'
import { normalizeRecipient } from '../web/agent-config.js'

// normalizeRecipient resolves an inter-agent message recipient to a known
// agent NAME, or null. The footgun: callers address the tmux SESSION name
// ("agent-dave") instead of the agent NAME ("dave"); that used to queue and
// silently vanish. The known-agent predicate is injected so the resolution
// logic is testable without the filesystem.

const known = new Set(['dave', 'marveen', 'thor'])
const isKnown = (name: string) => known.has(name)

describe('normalizeRecipient', () => {
  it('keeps an already-known agent name verbatim', () => {
    expect(normalizeRecipient('dave', isKnown)).toBe('dave')
    expect(normalizeRecipient('marveen', isKnown)).toBe('marveen')
  })

  it('strips a single leading "agent-" session prefix to the known name', () => {
    expect(normalizeRecipient('agent-dave', isKnown)).toBe('dave')
    expect(normalizeRecipient('agent-thor', isKnown)).toBe('thor')
  })

  it('trims surrounding whitespace before resolving', () => {
    expect(normalizeRecipient('  dave  ', isKnown)).toBe('dave')
    expect(normalizeRecipient(' agent-dave ', isKnown)).toBe('dave')
  })

  it('returns null for an unknown recipient (so the caller can 400)', () => {
    expect(normalizeRecipient('nobody', isKnown)).toBeNull()
    expect(normalizeRecipient('agent-nobody', isKnown)).toBeNull()
  })

  it('returns null for empty / blank / nullish input', () => {
    expect(normalizeRecipient('', isKnown)).toBeNull()
    expect(normalizeRecipient('   ', isKnown)).toBeNull()
    expect(normalizeRecipient(undefined as unknown as string, isKnown)).toBeNull()
  })

  it('strips only one "agent-" prefix, not repeated ones', () => {
    // "agent-agent-dave" -> strip once -> "agent-dave", which is not a known
    // agent, so it stays unresolved rather than masking a malformed address.
    expect(normalizeRecipient('agent-agent-dave', isKnown)).toBeNull()
  })

  it('prefers an exact known match over prefix-stripping', () => {
    // If "agent-dave" were itself a registered agent, keep it verbatim.
    const knownWithPrefix = (n: string) => n === 'agent-dave'
    expect(normalizeRecipient('agent-dave', knownWithPrefix)).toBe('agent-dave')
  })
})
