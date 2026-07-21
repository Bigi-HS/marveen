import { describe, it, expect } from 'vitest'
import { agentDisplayName } from './display-name'

describe('agentDisplayName (Boss display-name rule, TG3771)', () => {
  it('remaps the five non-trivial agent ids to their Boss-given names', () => {
    expect(agentDisplayName('marveen')).toBe('NoA')
    expect(agentDisplayName('scout')).toBe('Dr. Stone')
    expect(agentDisplayName('forge')).toBe('Armorer')
    expect(agentDisplayName('quill')).toBe('Kalapács')
    expect(agentDisplayName('devil-advocate')).toBe('Ördög Ügyvédje')
  })

  it('capitalizes every other id, splitting hyphens into words', () => {
    expect(agentDisplayName('dave')).toBe('Dave')
    expect(agentDisplayName('big-ben')).toBe('Big Ben')
  })

  it('passes already-capitalized names through unchanged', () => {
    expect(agentDisplayName('Genesis')).toBe('Genesis')
  })

  it('returns null for null/undefined/empty (caller supplies the placeholder)', () => {
    expect(agentDisplayName(null)).toBeNull()
    expect(agentDisplayName(undefined)).toBeNull()
    expect(agentDisplayName('')).toBeNull()
  })
})
