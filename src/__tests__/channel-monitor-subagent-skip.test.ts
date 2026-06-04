import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { readFileSync as fsRead } from 'node:fs'

// Source-contract tests for the intentionally-enabled gate in channel-monitor.ts.
// The gate is at the sub-agent targets-list inclusion point; a channel-less agent
// (no plugin key in settings.json) must never reach the plugin-health restart path.
const MONITOR_SRC = fsRead(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
const AGENT_PROC_SRC = fsRead(join(__dirname, '../web/agent-process.ts'), 'utf-8')

describe('channel-monitor: channel-less sub-agent skip (fix for Dave restart-loop)', () => {
  it('imports isAgentChannelIntentionallyEnabled from agent-process', () => {
    expect(MONITOR_SRC).toMatch(/isAgentChannelIntentionallyEnabled/)
  })

  it('gates sub-agent targets with isAgentChannelIntentionallyEnabled (not just agentHasChannel)', () => {
    // Find the targets-building loop
    const loopIdx = MONITOR_SRC.indexOf('for (const a of listAgentNames())')
    expect(loopIdx, 'sub-agent loop not found').toBeGreaterThan(0)
    const loopBody = MONITOR_SRC.slice(loopIdx, loopIdx + 600)
    expect(loopBody).toMatch(/isAgentChannelIntentionallyEnabled\(a\)/)
    // The old gate alone is not sufficient -- the new function must co-exist
    expect(loopBody).toMatch(/agentHasChannel\(a\)/)
    expect(loopBody).toMatch(/isAgentRunning\(a\)/)
  })

  it('uses && conjunction so all three guards must pass before adding to targets', () => {
    const loopIdx = MONITOR_SRC.indexOf('for (const a of listAgentNames())')
    const condition = MONITOR_SRC.slice(loopIdx, loopIdx + 900)
    // The three guards must be ANDed together (comment may appear before the if)
    expect(condition).toMatch(/isAgentRunning\(a\) && agentHasChannel\(a\) && isAgentChannelIntentionallyEnabled\(a\)/)
  })
})

describe('isAgentChannelIntentionallyEnabled -- source contract', () => {
  // The decision logic itself is covered behaviorally in channel-intent.test.ts
  // (the pure channelIntentFromEnabledPlugins). These contracts pin how
  // agent-process wires that shared helper to the agent's LAUNCH settings so the
  // ed2525f1 fix (read .claude/settings.json, not the channel-neutral
  // .claude-config copy) cannot silently regress.

  it('is exported from agent-process', () => {
    expect(AGENT_PROC_SRC).toMatch(/export function isAgentChannelIntentionallyEnabled/)
  })

  it('reads the agent LAUNCH settings (.claude/settings.json), not .claude-config', () => {
    const fnIdx = AGENT_PROC_SRC.indexOf('export function isAgentChannelIntentionallyEnabled')
    const fnEnd = AGENT_PROC_SRC.indexOf('\nexport ', fnIdx + 1)
    const fnBody = AGENT_PROC_SRC.slice(fnIdx, fnEnd > fnIdx ? fnEnd : fnIdx + 1500)
    // launch settings path is <dir>/.claude/settings.json
    expect(fnBody).toMatch(/join\(dir, '\.claude', 'settings\.json'\)/)
    // must NOT resolve intent from the channel-neutral .claude-config copy
    expect(fnBody).not.toMatch(/\.claude-config['"\s,]+['"]settings\.json/)
  })

  it('delegates the decision to the shared channelIntentFromEnabledPlugins helper', () => {
    expect(AGENT_PROC_SRC).toMatch(/channelIntentFromEnabledPlugins/)
    const fnIdx = AGENT_PROC_SRC.indexOf('export function isAgentChannelIntentionallyEnabled')
    const fnEnd = AGENT_PROC_SRC.indexOf('\nexport ', fnIdx + 1)
    const fnBody = AGENT_PROC_SRC.slice(fnIdx, fnEnd > fnIdx ? fnEnd : fnIdx + 1500)
    expect(fnBody).toMatch(/channelIntentFromEnabledPlugins\(/)
  })

  it('falls back to agentHasChannel when no launch settings.json exists', () => {
    expect(AGENT_PROC_SRC).toMatch(/return agentHasChannel\(name\)/)
  })
})

describe('agent-preflight: channel intent fact stays in lockstep with agent-process', () => {
  const PREFLIGHT_SRC = fsRead(join(__dirname, '../web/agent-preflight.ts'), 'utf-8')

  it('also resolves channel intent from .claude/settings.json via the shared helper', () => {
    expect(PREFLIGHT_SRC).toMatch(/channelIntentFromEnabledPlugins/)
    expect(PREFLIGHT_SRC).toMatch(/join\(dir, '\.claude', 'settings\.json'\)/)
  })
})
