import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Source-assertion coverage for fleet-supervisor.sh G2 (usage-limit modal auto-dismiss)
// and G3 (login-box auto-dismiss) wiring (card 9644ed7c G2+G3).
//
// The bash functions (g2_apply_recover, g3_apply_recover) follow the same
// 2-strike + TOCTOU pattern as g6_apply_2strike and g1_apply_send_enter.
// Tests here pin the structural contract (function defined, wired in Phase 3,
// strike-clear in healthy branch, fail-closed shape) so a future refactor
// cannot accidentally drop the recovery or revert to the old "wedged_list only" path.

const INSTALL_DIR = join(__dirname, '../..')
const SRC = readFileSync(join(INSTALL_DIR, 'scripts/fleet-supervisor.sh'), 'utf-8')

describe('fleet-supervisor.sh G2 recovery (usage-limit modal)', () => {
  it('defines g2_apply_recover function', () => {
    expect(SRC).toMatch(/^g2_apply_recover\(\)/m)
  })

  it('uses 2-strike persistence via wedge_arm_2strike', () => {
    expect(SRC).toMatch(/wedge_arm_2strike g2/)
  })

  it('sends Escape then 0 as recovery keys (gated by DETECTOR_COMMON_ENABLED)', () => {
    // g2_apply_recover must gate on DETECTOR_COMMON_ENABLED, send Escape, then '0'
    expect(SRC).toMatch(/g2_apply_recover[\s\S]{0,1500}DETECTOR_COMMON_ENABLED/)
    expect(SRC).toMatch(/g2_apply_recover[\s\S]{0,1500}Escape/)
    expect(SRC).toMatch(/g2_apply_recover[\s\S]{0,1500}'0'/)
  })

  it('Phase 3 dispatcher routes limit -> g2_apply_recover, not bare wedged_list append', () => {
    // The old code was: else wedged_list="$wedged_list ${_agent}:G2"
    // New code routes through g2_apply_recover first.
    expect(SRC).toMatch(/limit\)\s*\n\s*if wedge_sleep_suppress[\s\S]{0,300}g2_apply_recover/)
  })

  it('dismissed result adds to dismissed_list (not wedged_list)', () => {
    expect(SRC).toMatch(/dismissed\) dismissed_list="\$dismissed_list \$\{_agent\}:G2"/)
  })

  it('resets G2 strike on healthy pane (prevents stale strike accumulation)', () => {
    expect(SRC).toMatch(/wedge_arm_strike_clear g2/)
  })

  it('TOCTOU re-verify checks for usage-limit markers before sending', () => {
    expect(SRC).toMatch(/Stop and wait for limit to reset/)
    expect(SRC).toMatch(/G2 auto-dismiss/)
  })
})

describe('fleet-supervisor.sh G3 recovery (login-box)', () => {
  it('defines g3_apply_recover function', () => {
    expect(SRC).toMatch(/^g3_apply_recover\(\)/m)
  })

  it('uses 2-strike persistence via wedge_arm_2strike', () => {
    expect(SRC).toMatch(/wedge_arm_2strike g3/)
  })

  it('sends Escape as recovery key (gated by DETECTOR_COMMON_ENABLED)', () => {
    expect(SRC).toMatch(/G3 auto-dismiss.*Escape|Escape[\s\S]{0,100}G3 auto-dismiss/)
  })

  it('Phase 3 dispatcher has a login) case that calls g3_apply_recover', () => {
    expect(SRC).toMatch(/login\)\s*\n\s*# G3[\s\S]{0,300}g3_apply_recover/)
  })

  it('dismissed result adds to dismissed_list (not wedged_list)', () => {
    expect(SRC).toMatch(/dismissed\) dismissed_list="\$dismissed_list \$\{_agent\}:G3"/)
  })

  it('resets G3 strike on healthy pane (prevents stale strike accumulation)', () => {
    expect(SRC).toMatch(/wedge_arm_strike_clear g3/)
  })

  it('TOCTOU re-verify checks for login-box markers before sending Escape', () => {
    expect(SRC).toMatch(/claude\.ai\/login|claude\.ai\/oauth|Sign in to Claude/)
    expect(SRC).toMatch(/G3 auto-dismiss/)
  })
})
