// P4a: agent-config schema v2 validator (card feat/p4a-config-schema-v2).
//
// Schema version 1 (implicit): `model` optional; missing model silently inherits
// DEFAULT_MODEL at runtime -- non-deterministic, breaks cost modelling.
// Schema version 2: `model` OR `archetype` REQUIRED. Missing both is a HARD-FAIL.
//
// This module is pure (no filesystem, no env reads) so it is unit-testable and
// can be called from both runtime validation paths and the CI tier-gate.

import {
  resolveAgentModelFromConfig,
  resolveModelId,
  modelForArchetype,
  MODEL_REGISTRY,
  ARCHETYPE_MODEL,
} from './agent-config.js'

export const AGENT_CONFIG_SCHEMA_VERSION = 2

export interface AgentConfigV2ValidationResult {
  valid: boolean
  error?: string
  resolvedModel?: string
  unknownModel?: boolean
  schemaVersion: typeof AGENT_CONFIG_SCHEMA_VERSION
}

// Validate an agent-config.json object against schema v2.
//
// HARD-FAIL conditions (valid=false):
//   - Input is not an object (null/string/number/array)
//   - Neither `model` nor `archetype` field is present (or both are blank strings)
//   - `archetype` is present but not a known archetype key (cannot produce a
//     deterministic model; a typo in archetype is indistinguishable from intent)
//
// OK conditions (valid=true):
//   - `model` is a non-blank string (alias-resolved; unknown model ids are
//     flagged as unknownModel=true but not blocked -- the fleet uses models like
//     `claude-haiku-5-5` that predate the current registry)
//   - `archetype` is a known key in ARCHETYPE_MODEL and no explicit `model`
//   - both present: `model` wins (same precedence as resolveAgentModelFromConfig)
export function validateAgentConfigV2(config: unknown): AgentConfigV2ValidationResult {
  const FAIL = (error: string): AgentConfigV2ValidationResult => ({
    valid: false,
    error,
    schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
  })

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return FAIL('config must be a JSON object')
  }

  const c = config as Record<string, unknown>
  const rawModel = typeof c['model'] === 'string' ? c['model'].trim() : null
  const rawArchetype = typeof c['archetype'] === 'string' ? c['archetype'].trim() : null

  // Both absent or blank -> HARD-FAIL
  if (!rawModel && !rawArchetype) {
    return FAIL('missing required field: either `model` or `archetype` must be set (schema v2)')
  }

  // Explicit model wins
  if (rawModel) {
    const resolved = resolveModelId(rawModel)
    const unknownModel = !(resolved in MODEL_REGISTRY)
    return {
      valid: true,
      resolvedModel: resolved,
      unknownModel: unknownModel || undefined,
      schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
    }
  }

  // Archetype path: must be a known key
  const archetypeResolved = modelForArchetype(rawArchetype)
  if (!archetypeResolved) {
    return FAIL(
      `archetype unknown: "${rawArchetype}" is not in ARCHETYPE_MODEL (${Object.keys(ARCHETYPE_MODEL).join(', ')})`,
    )
  }

  return {
    valid: true,
    resolvedModel: archetypeResolved,
    schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
  }
}
