import { describe, it, expect } from 'vitest'
import { buildAssigneeList } from '../web/routes/kanban.js'

// buildAssigneeList wires per-entry avatar metadata for the kanban assignee list
// (card 6de93bd6: real agent avatars on card chips instead of a letter dot). It is
// dependency-injected so the avatar-flag logic is testable without the real
// agents/ filesystem.

const base = {
  ownerName: 'Boss',
  botName: 'Genesis',
  botAvatarUrl: '/api/marveen/avatar',
  agentNames: ['dave', 'thor'],
  agentDisplayName: (n: string) => ({ dave: 'Dave', thor: 'Thor' }[n] ?? null),
  agentHasAvatar: (n: string) => n === 'dave', // dave has an avatar file, thor does not
}

describe('buildAssigneeList', () => {
  it('puts owner first with a letter dot (no avatar endpoint for the human owner)', () => {
    const list = buildAssigneeList(base)
    expect(list[0]).toEqual({ name: 'Boss', type: 'owner' })
    expect(list[0].hasImage).toBeUndefined()
    expect(list[0].avatarUrl).toBeUndefined()
  })

  it('gives the bot an always-on avatar (its endpoint serves a fallback image)', () => {
    const bot = buildAssigneeList(base).find((a) => a.type === 'bot')!
    expect(bot.name).toBe('Genesis')
    expect(bot.hasImage).toBe(true)
    expect(bot.avatarUrl).toBe('/api/marveen/avatar')
  })

  it('marks an agent with an avatar file as hasImage with the per-agent URL', () => {
    const dave = buildAssigneeList(base).find((a) => a.name === 'dave')!
    expect(dave.type).toBe('agent')
    expect(dave.displayName).toBe('Dave')
    expect(dave.hasImage).toBe(true)
    expect(dave.avatarUrl).toBe('/api/agents/dave/avatar')
  })

  it('marks an agent without an avatar file as hasImage=false (chip falls back to the letter dot)', () => {
    const thor = buildAssigneeList(base).find((a) => a.name === 'thor')!
    expect(thor.hasImage).toBe(false)
    // avatarUrl is still provided but the frontend ignores it when hasImage is false.
    expect(thor.avatarUrl).toBe('/api/agents/thor/avatar')
  })

  it('falls back to the raw name when no displayName is configured', () => {
    const list = buildAssigneeList({ ...base, agentNames: ['scout'], agentDisplayName: () => null })
    expect(list.find((a) => a.name === 'scout')!.displayName).toBe('scout')
  })

  it('URL-encodes the agent name in the avatar URL', () => {
    const list = buildAssigneeList({
      ...base,
      agentNames: ['weird name'],
      agentDisplayName: () => null,
      agentHasAvatar: () => true,
    })
    expect(list.find((a) => a.name === 'weird name')!.avatarUrl).toBe('/api/agents/weird%20name/avatar')
  })

  it('returns owner, bot, then agents in order', () => {
    expect(buildAssigneeList(base).map((a) => a.type)).toEqual(['owner', 'bot', 'agent', 'agent'])
  })
})
