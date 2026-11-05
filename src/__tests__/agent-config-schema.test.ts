import { describe, it, expect } from 'vitest'
import {
  validateAgentConfigV2,
  AGENT_CONFIG_SCHEMA_VERSION,
  type AgentConfigV2ValidationResult,
} from '../web/agent-config-schema.js'

// Unit tests for the P4a schema-v2 validator (card feat/p4a-config-schema-v2).
//
// The key contract: a config WITHOUT both `model` and `archetype` is a HARD-FAIL.
// Silently falling back to DEFAULT_MODEL in production means an operator can
// accidentally deploy an agent on whatever the DEFAULT is at the time -- a
// non-deterministic choice that breaks cost modelling and cross-fleet
// reproducibility. schema_version=2 makes the model explicit and mandatory.

describe('validateAgentConfigV2 -- HARD-FAIL on missing model (falszifikáló)', () => {
  it('HARD-FAILs when neither model nor archetype is present', () => {
    const r = validateAgentConfigV2({ displayName: 'NoA' })
    expect(r.valid).toBe(false)
    expect(r.error).toBeTruthy()
    expect(r.resolvedModel).toBeUndefined()
  })

  it('HARD-FAILs on completely empty config', () => {
    const r = validateAgentConfigV2({})
    expect(r.valid).toBe(false)
  })

  it('HARD-FAILs on non-object input', () => {
    expect(validateAgentConfigV2(null).valid).toBe(false)
    expect(validateAgentConfigV2('string').valid).toBe(false)
    expect(validateAgentConfigV2(42).valid).toBe(false)
  })

  it('HARD-FAILs when model is present but empty string', () => {
    const r = validateAgentConfigV2({ model: '' })
    expect(r.valid).toBe(false)
  })

  it('HARD-FAILs when model is present but whitespace-only', () => {
    const r = validateAgentConfigV2({ model: '   ' })
    expect(r.valid).toBe(false)
  })
})

describe('validateAgentConfigV2 -- valid config with explicit model', () => {
  it('passes for a known model id', () => {
    const r = validateAgentConfigV2({ model: 'claude-sonnet-4-6' })
    expect(r.valid).toBe(true)
    expect(r.resolvedModel).toBe('claude-sonnet-4-6')
    expect(r.schemaVersion).toBe(AGENT_CONFIG_SCHEMA_VERSION)
  })

  it('passes for a model alias and resolves to the full id', () => {
    // 'sonnet' alias -> 'claude-sonnet-4-6'
    const r = validateAgentConfigV2({ model: 'sonnet' })
    expect(r.valid).toBe(true)
    expect(r.resolvedModel).toBe('claude-sonnet-4-6')
  })

  it('passes for an unknown model id (not in registry) -- just a warning, not HARD-FAIL', () => {
    // claude-haiku-5-5 is used by several agents; unknown to registry but valid string
    const r = validateAgentConfigV2({ model: 'claude-haiku-5-5' })
    expect(r.valid).toBe(true)
    expect(r.resolvedModel).toBe('claude-haiku-5-5')
    expect(r.unknownModel).toBe(true)
  })

  it('passes for a full config object', () => {
    const r = validateAgentConfigV2({
      model: 'claude-sonnet-4-6',
      securityProfile: 'developer-senior',
      displayName: 'Thor',
      claudeConfigDir: '/path/to/.claude-config',
      channelProvider: 'telegram',
    })
    expect(r.valid).toBe(true)
    expect(r.resolvedModel).toBe('claude-sonnet-4-6')
  })
})

describe('validateAgentConfigV2 -- archetype as model source', () => {
  it('passes when archetype is present and no explicit model', () => {
    const r = validateAgentConfigV2({ archetype: 'engineer' })
    expect(r.valid).toBe(true)
    // archetype=engineer -> opus
    expect(r.resolvedModel).toMatch(/claude-opus/)
  })

  it('explicit model wins over archetype when both present', () => {
    const r = validateAgentConfigV2({ model: 'claude-sonnet-4-6', archetype: 'engineer' })
    expect(r.valid).toBe(true)
    expect(r.resolvedModel).toBe('claude-sonnet-4-6')
  })

  it('HARD-FAILs when archetype is present but empty string', () => {
    const r = validateAgentConfigV2({ archetype: '' })
    expect(r.valid).toBe(false)
  })

  it('HARD-FAILs when archetype is unknown (not in ARCHETYPE_MODEL)', () => {
    // An unknown archetype cannot produce a deterministic model -- HARD-FAIL.
    const r = validateAgentConfigV2({ archetype: 'unknown-archetype-xyz' })
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(/archetype.*unknown|unknown.*archetype/)
  })
})

describe('validateAgentConfigV2 -- schemaVersion field', () => {
  it('always returns schemaVersion on a valid config', () => {
    const r = validateAgentConfigV2({ model: 'claude-sonnet-4-6' })
    expect(r.schemaVersion).toBe(2)
    expect(AGENT_CONFIG_SCHEMA_VERSION).toBe(2)
  })
})
