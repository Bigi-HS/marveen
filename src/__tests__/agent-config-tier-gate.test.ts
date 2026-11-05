import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateAgentConfigV2 } from '../web/agent-config-schema.js'

// P4a tier-gate CI-check (card feat/p4a-config-schema-v2).
//
// Enumerates every agent-config.json in the fleet and validates it against the
// schema-v2 contract. The "deterministic-jelölt" (resolved model) for each agent
// is printed to stdout so the operator can confirm the full fleet model mapping
// at a glance. The test FAILS if any config is invalid (missing model/archetype).
//
// This is the gate: a future agent added without an explicit model is caught here
// before it ever runs in production on a silently-inherited DEFAULT_MODEL.

const INSTALL_DIR = join(__dirname, '../..')
const AGENTS_DIR = join(INSTALL_DIR, 'agents')

interface ConfigEntry {
  agentName: string
  configPath: string
  raw: unknown
}

function collectConfigs(): ConfigEntry[] {
  const entries: ConfigEntry[] = []

  // Root config (marveen/main orchestrator)
  const rootPath = join(INSTALL_DIR, 'agent-config.json')
  if (existsSync(rootPath)) {
    try {
      entries.push({ agentName: 'marveen (root)', configPath: rootPath, raw: JSON.parse(readFileSync(rootPath, 'utf-8')) })
    } catch {
      entries.push({ agentName: 'marveen (root)', configPath: rootPath, raw: null })
    }
  }

  // Per-agent configs
  for (const name of readdirSync(AGENTS_DIR)) {
    const cfgPath = join(AGENTS_DIR, name, 'agent-config.json')
    if (!existsSync(cfgPath)) continue
    try {
      entries.push({ agentName: name, configPath: cfgPath, raw: JSON.parse(readFileSync(cfgPath, 'utf-8')) })
    } catch {
      entries.push({ agentName: name, configPath: cfgPath, raw: null })
    }
  }

  return entries
}

describe('agent-config tier-gate (P4a schema-v2)', () => {
  const configs = collectConfigs()

  it('all agent configs have an explicit model or archetype (HARD-FAIL gate)', () => {
    const violations: string[] = []
    const rows: string[] = []

    for (const { agentName, configPath, raw } of configs) {
      const result = validateAgentConfigV2(raw)
      const status = result.valid ? 'PASS' : 'FAIL'
      const modelCol = result.valid ? (result.resolvedModel ?? '?') : `ERROR: ${result.error ?? 'unknown'}`
      const unknownFlag = result.valid && result.unknownModel ? ' [model not in registry]' : ''
      rows.push(`  ${status.padEnd(5)} ${agentName.padEnd(25)} ${modelCol}${unknownFlag}`)
      if (!result.valid) {
        violations.push(`${agentName} (${configPath}): ${result.error ?? 'validation failed'}`)
      }
    }

    // Print the deterministic model table (the "deterministic-jelölt" output).
    console.log('\n=== P4a agent-config tier-gate: deterministic model map ===')
    rows.forEach((r) => console.log(r))
    console.log(`Total: ${configs.length} configs, ${violations.length} violations`)

    expect(violations, `Config violations (fix with P4b or add model/archetype now):\n${violations.join('\n')}`).toHaveLength(0)
  })
})
