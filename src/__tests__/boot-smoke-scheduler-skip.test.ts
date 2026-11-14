// Boot-smoke scheduler-skip (card 29a07a64, Finding A).
//
// NOA_BOOT_SMOKE=<port> (src/index.ts) boots the DB + web listener ONLY to prove
// the build boots, with NO live side effects. The documented index.ts contract is
// that it starts NO scheduler -- but startWebServer unconditionally called
// startScheduleRunner, whose migrateFileBasedTasks INSERTs crash on a fresh
// hermetic DB, masking the very boot-crash class the smoke exists to catch.
//
// We prove the pure gate here (no port bind, no DB): isBootSmokeMode reads the
// same flag index.ts uses, and maybeStartScheduleRunner calls the runner ONLY in
// the live path. The runner is injected so the test never triggers the real
// scheduler's DB side effects.

import { describe, it, expect } from 'vitest'
import { isBootSmokeMode, maybeStartScheduleRunner } from '../web/schedule-runner.js'

const fakeTimer = {} as NodeJS.Timeout

describe('isBootSmokeMode (same NOA_BOOT_SMOKE flag as index.ts)', () => {
  it('valid port -> boot-smoke', () => {
    expect(isBootSmokeMode({ NOA_BOOT_SMOKE: '3497' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('unset -> live', () => {
    expect(isBootSmokeMode({} as NodeJS.ProcessEnv)).toBe(false)
  })

  it('empty string -> live', () => {
    expect(isBootSmokeMode({ NOA_BOOT_SMOKE: '' } as NodeJS.ProcessEnv)).toBe(false)
  })

  it('zero port -> live (port must be > 0)', () => {
    expect(isBootSmokeMode({ NOA_BOOT_SMOKE: '0' } as NodeJS.ProcessEnv)).toBe(false)
  })

  it('negative port -> live', () => {
    expect(isBootSmokeMode({ NOA_BOOT_SMOKE: '-5' } as NodeJS.ProcessEnv)).toBe(false)
  })

  it('non-numeric -> live', () => {
    expect(isBootSmokeMode({ NOA_BOOT_SMOKE: 'abc' } as NodeJS.ProcessEnv)).toBe(false)
  })
})

describe('maybeStartScheduleRunner (Finding A gate)', () => {
  it('boot-smoke mode: does NOT call the runner, returns undefined', () => {
    let calls = 0
    const result = maybeStartScheduleRunner(
      { NOA_BOOT_SMOKE: '3497' } as NodeJS.ProcessEnv,
      () => { calls++; return fakeTimer },
    )
    expect(calls).toBe(0)
    expect(result).toBeUndefined()
  })

  it('live mode: calls the runner once, returns its interval', () => {
    let calls = 0
    const result = maybeStartScheduleRunner(
      {} as NodeJS.ProcessEnv,
      () => { calls++; return fakeTimer },
    )
    expect(calls).toBe(1)
    expect(result).toBe(fakeTimer)
  })
})
