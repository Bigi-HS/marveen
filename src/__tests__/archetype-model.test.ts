import { describe, it, expect } from 'vitest'
import {
  ARCHETYPE_MODEL,
  modelForArchetype,
  resolveAgentModelFromConfig,
  resolveModelId,
  DEFAULT_MODEL,
} from '../web/agent-config.js'

// Model right-sizing (Phase 2): an agent's archetype picks a sensibly-sized
// model so the fleet does not run everything on opus. The precedence and the
// policy map are pure, so they are unit-tested directly here.

describe('modelForArchetype', () => {
  it('maps heartbeat/monitor/canary to haiku (resolved id)', () => {
    const haiku = resolveModelId('haiku')
    expect(modelForArchetype('heartbeat')).toBe(haiku)
    expect(modelForArchetype('monitor')).toBe(haiku)
    expect(modelForArchetype('canary')).toBe(haiku)
  })
  it('maps chat/assistant/orchestrator to sonnet', () => {
    const sonnet = resolveModelId('sonnet')
    expect(modelForArchetype('chat')).toBe(sonnet)
    expect(modelForArchetype('assistant')).toBe(sonnet)
    expect(modelForArchetype('orchestrator')).toBe(sonnet)
  })
  it('maps engineer/architect/debug to opus', () => {
    const opus = resolveModelId('opus')
    expect(modelForArchetype('engineer')).toBe(opus)
    expect(modelForArchetype('architect')).toBe(opus)
    expect(modelForArchetype('debug')).toBe(opus)
  })
  it('is case-insensitive and trims', () => {
    expect(modelForArchetype('  HeartBeat ')).toBe(resolveModelId('haiku'))
  })
  it('returns null for missing/unknown archetypes', () => {
    expect(modelForArchetype(null)).toBeNull()
    expect(modelForArchetype(undefined)).toBeNull()
    expect(modelForArchetype('')).toBeNull()
    expect(modelForArchetype('nonsense')).toBeNull()
  })
  it('every policy value resolves to a real (non-alias) model id', () => {
    for (const [arch, alias] of Object.entries(ARCHETYPE_MODEL)) {
      const id = modelForArchetype(arch)
      expect(id, arch).toBe(resolveModelId(alias))
      // resolved id must not itself still be an alias key
      expect(Object.keys(ARCHETYPE_MODEL)).not.toContain(id)
    }
  })
})

describe('resolveAgentModelFromConfig (precedence)', () => {
  it('explicit model always wins (backward compatible, no live change)', () => {
    expect(resolveAgentModelFromConfig({ model: 'claude-opus-4-8[1m]', archetype: 'heartbeat' }))
      .toBe('claude-opus-4-8[1m]')
  })
  it('explicit model alias is resolved', () => {
    expect(resolveAgentModelFromConfig({ model: 'opus' })).toBe(resolveModelId('opus'))
  })
  it('falls back to archetype default when no explicit model', () => {
    expect(resolveAgentModelFromConfig({ archetype: 'monitor' })).toBe(resolveModelId('haiku'))
  })
  it('falls back to DEFAULT_MODEL when neither is set', () => {
    expect(resolveAgentModelFromConfig({})).toBe(DEFAULT_MODEL)
  })
  it('blank/whitespace model is ignored, archetype used', () => {
    expect(resolveAgentModelFromConfig({ model: '   ', archetype: 'engineer' }))
      .toBe(resolveModelId('opus'))
  })
  it('unknown archetype with no model -> DEFAULT_MODEL', () => {
    expect(resolveAgentModelFromConfig({ archetype: 'wizard' })).toBe(DEFAULT_MODEL)
  })
})
