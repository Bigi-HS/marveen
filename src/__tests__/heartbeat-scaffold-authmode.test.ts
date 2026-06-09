import { describe, it, expect } from 'vitest'
import { renderAgentConfigJson } from '../web/heartbeat-agent-scaffold.js'

// The heartbeat scaffold's agent-config.json is in ALWAYS_WRITE, so
// ensureHeartbeatAgent() rewrites the on-disk config from the template on EVERY
// dashboard boot. If the template emits an authMode outside VALID_AUTH_MODES
// (it historically hardcoded the invalid "oauth"), each boot would clobber the
// committed fix and reintroduce the misleading silent-fallback value -- and the
// live-box authMode invariant test would flip red after a reboot. This locks
// the template to a recognised mode so a re-scaffold can never undo PR #97.
const VALID_AUTH_MODES = new Set(['shared', 'own_team', 'api'])

describe('heartbeat scaffold -- rendered agent-config.json authMode', () => {
  it('renders a recognised authMode (not the silent-fallback "oauth")', () => {
    const cfg = JSON.parse(renderAgentConfigJson())
    expect(cfg.authMode).toBeDefined()
    expect(VALID_AUTH_MODES.has(cfg.authMode)).toBe(true)
  })

  it('uses shared auth -- the host fleet OAuth every channel-less sub-agent runs under', () => {
    const cfg = JSON.parse(renderAgentConfigJson())
    expect(cfg.authMode).toBe('shared')
  })
})
