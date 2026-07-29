import { describe, it, expect } from 'vitest'
import { agentDisplayName } from './display-name'

describe('agentDisplayName (Boss display-name rule, TG3771)', () => {
  it('remaps the non-trivial agent ids to their Boss-given names', () => {
    expect(agentDisplayName('marveen')).toBe('NoA')
    expect(agentDisplayName('scout')).toBe('Dr. Stone')
    expect(agentDisplayName('forge')).toBe('Armorer')
    expect(agentDisplayName('quill')).toBe('Kalapács')
    expect(agentDisplayName('devil-advocate')).toBe('Ördög Ügyvédje')
    expect(agentDisplayName('radar')).toBe('Grace')
    expect(agentDisplayName('gauge')).toBe('Dampier')
    // bigben has no hyphen, so title-casing alone would give "Bigben".
    expect(agentDisplayName('bigben')).toBe('Big Ben')
    // gyore's accent is lost by naive title-casing ("Gyore").
    expect(agentDisplayName('gyore')).toBe('Györe')
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
