import { describe, it, expect } from 'vitest'
import { renderAgentConfigJson } from '../web/heartbeat-agent-scaffold.js'
import { profileExists } from '../web/profiles.js'

// The heartbeat scaffold's agent-config.json is in ALWAYS_WRITE, so
// ensureHeartbeatAgent() rewrites the on-disk config from the template on EVERY
// dashboard boot. It historically hardcoded securityProfile "standard" -- a
// profile that does NOT exist under templates/profiles/, so loadProfileTemplate
// silently fell back to the permissive default (fail-OPEN, SEC-098). This locks
// the template to a REAL profile so a re-scaffold can never reintroduce the
// silent downgrade, mirroring the authMode invariant guard for the same file.
describe('heartbeat scaffold -- rendered agent-config.json securityProfile', () => {
  it('renders a securityProfile that actually exists under templates/profiles/', () => {
    const cfg = JSON.parse(renderAgentConfigJson())
    expect(cfg.securityProfile).toBeDefined()
    expect(profileExists(cfg.securityProfile)).toBe(true)
  })

  it('is NOT the non-existent "standard" silent-fallback value', () => {
    const cfg = JSON.parse(renderAgentConfigJson())
    expect(cfg.securityProfile).not.toBe('standard')
  })
})
