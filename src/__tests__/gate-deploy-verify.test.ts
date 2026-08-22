import { describe, it, expect, afterEach } from 'vitest'
import { runDeployVerify, __setDeployVerifyDeps, __resetDeployVerifyDeps } from '../web/deploy-verify.js'
import type { DeployVerifyDeps } from '../web/deploy-verify.js'

afterEach(() => __resetDeployVerifyDeps())

// Fully-healthy fleet baseline -- every check passes.
const healthy: DeployVerifyDeps = {
  isSessionAlive: () => true,
  isPgrepMatch: () => true,
  listAgents: () => ['dave', 'thor'],
  hasChannel: () => true,
  isChannelIntentional: () => true,
  getChannelProvider: () => 'telegram',
  getVaultSecret: () => 'TOKEN_CONTENT',
  isDbAccessible: () => true,
}

describe('runDeployVerify', () => {
  it('returns pass:true and score:4 when all checks succeed', () => {
    __setDeployVerifyDeps(healthy)
    const r = runDeployVerify()
    expect(r.pass).toBe(true)
    expect(r.score).toBe(4)
    expect(r.total).toBe(4)
    expect(r.checks.F1.pass).toBe(true)
    expect(r.checks.F2.pass).toBe(true)
    expect(r.checks.F3.pass).toBe(true)
    expect(r.checks.F4.pass).toBe(true)
  })

  it('F1 fails when DB is not accessible', () => {
    __setDeployVerifyDeps({ ...healthy, isDbAccessible: () => false })
    const r = runDeployVerify()
    expect(r.checks.F1.pass).toBe(false)
    expect(r.pass).toBe(false)
    expect(r.score).toBe(3)
  })

  it('F2 fails when a tmux session is missing', () => {
    __setDeployVerifyDeps({
      ...healthy,
      // make the marveen-channels session dead
      isSessionAlive: (name) => name !== 'marveen-channels',
    })
    const r = runDeployVerify()
    expect(r.checks.F2.pass).toBe(false)
    expect(r.checks.F2.detail).toMatch(/marveen-channels/)
    expect(r.pass).toBe(false)
  })

  it('F2 fails when an agent session is missing', () => {
    __setDeployVerifyDeps({
      ...healthy,
      isSessionAlive: (name) => name !== 'agent-thor',
    })
    const r = runDeployVerify()
    expect(r.checks.F2.pass).toBe(false)
    expect(r.checks.F2.detail).toMatch(/agent-thor/)
  })

  it('F2 fails when a watchdog process is missing', () => {
    __setDeployVerifyDeps({
      ...healthy,
      isPgrepMatch: (p) => !p.includes('dave-watchdog'),
    })
    const r = runDeployVerify()
    expect(r.checks.F2.pass).toBe(false)
    expect(r.checks.F2.detail).toMatch(/dave-watchdog/)
  })

  it('F3 fails when a channel agent is intentionally disabled', () => {
    __setDeployVerifyDeps({
      ...healthy,
      isChannelIntentional: (name) => name !== 'dave',
    })
    const r = runDeployVerify()
    expect(r.checks.F3.pass).toBe(false)
    expect(r.checks.F3.detail).toMatch(/dave/)
  })

  it('F3 ignores agents without a channel', () => {
    __setDeployVerifyDeps({
      ...healthy,
      hasChannel: (name) => name === 'dave',
      isChannelIntentional: (name) => name === 'dave',
    })
    const r = runDeployVerify()
    expect(r.checks.F3.pass).toBe(true)
  })

  it('F4 fails when vault backup is missing for a channel agent', () => {
    __setDeployVerifyDeps({
      ...healthy,
      getVaultSecret: (id) => (id.includes('thor') ? null : 'TOKEN'),
    })
    const r = runDeployVerify()
    expect(r.checks.F4.pass).toBe(false)
    expect(r.checks.F4.detail).toMatch(/thor/)
  })

  it('F4 passes when agent has channel but provider is null (skip)', () => {
    __setDeployVerifyDeps({
      ...healthy,
      getChannelProvider: () => null,
    })
    const r = runDeployVerify()
    // no provider -> no vault id -> cannot fail F4
    expect(r.checks.F4.pass).toBe(true)
  })

  it('F4 passes when no agents have channels', () => {
    __setDeployVerifyDeps({
      ...healthy,
      hasChannel: () => false,
    })
    const r = runDeployVerify()
    expect(r.checks.F4.pass).toBe(true)
  })

  it('F2 ignores *-local agents (dev-only clones, never run as prod sessions)', () => {
    // Simulate listAgents returning local dev clones alongside real agents.
    // The real deps filter removes *-local before session check -- replicate via dep injection.
    __setDeployVerifyDeps({
      ...healthy,
      listAgents: () => ['dave', 'claudia-local', 'marveen-local'],
      // sessions only alive for real agent, not -local clones
      isSessionAlive: (name) => !['agent-claudia-local', 'agent-marveen-local'].includes(name),
    })
    // Without the filter these would fail F2; with it they are excluded at realDeps level.
    // Here we test the verify logic when caller already provides the filtered list:
    const r = runDeployVerify()
    expect(r.checks.F2.pass).toBe(true)
  })

  it('returns pass:false and score:0 when everything fails', () => {
    __setDeployVerifyDeps({
      isSessionAlive: () => false,
      isPgrepMatch: () => false,
      listAgents: () => ['dave'],
      hasChannel: () => true,
      isChannelIntentional: () => false,
      getChannelProvider: () => 'telegram',
      getVaultSecret: () => null,
      isDbAccessible: () => false,
    })
    const r = runDeployVerify()
    expect(r.pass).toBe(false)
    expect(r.score).toBe(0)
  })
})
