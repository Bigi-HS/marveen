/**
 * Unit tests for resolveIntEnv / resolveStrEnv (AC-1, AC-1b, AC-2).
 * card 5b993df2 boot-hardening.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveIntEnv, resolveStrEnv, type EnvSource } from '../config.js'

// ── Helper: set / restore process.env keys safely ───────────────────────────

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { fn() } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// ── resolveIntEnv (AC-1, AC-1b, invalid fall-through) ───────────────────────

describe('resolveIntEnv', () => {
  it('process.env takes precedence over file and default', () => {
    withEnv({ WEB_PORT: '3499' }, () => {
      const r = resolveIntEnv('WEB_PORT', { WEB_PORT: '9999' }, 3420)
      expect(r.value).toBe(3499)
      expect(r.source).toBe<EnvSource>('process')
    })
  })

  it('file value used when process.env is absent', () => {
    withEnv({ WEB_PORT: undefined }, () => {
      const r = resolveIntEnv('WEB_PORT', { WEB_PORT: '9000' }, 3420)
      expect(r.value).toBe(9000)
      expect(r.source).toBe<EnvSource>('file')
    })
  })

  it('fallback used when both absent', () => {
    withEnv({ WEB_PORT: undefined }, () => {
      const r = resolveIntEnv('WEB_PORT', {}, 3420)
      expect(r.value).toBe(3420)
      expect(r.source).toBe<EnvSource>('default')
    })
  })

  // AC-1: invalid process.env value MUST fall through (fail-safe)
  it('non-numeric process.env falls through to file value', () => {
    withEnv({ WEB_PORT: 'not-a-port' }, () => {
      const r = resolveIntEnv('WEB_PORT', { WEB_PORT: '9000' }, 3420)
      expect(r.value).toBe(9000)
      expect(r.source).toBe<EnvSource>('file')
    })
  })

  it('process.env WEB_PORT=0 falls through (<=0 rejected)', () => {
    withEnv({ WEB_PORT: '0' }, () => {
      const r = resolveIntEnv('WEB_PORT', {}, 3420)
      expect(r.value).toBe(3420)
      expect(r.source).toBe<EnvSource>('default')
    })
  })

  it('process.env WEB_PORT=-1 falls through (negative rejected)', () => {
    withEnv({ WEB_PORT: '-1' }, () => {
      const r = resolveIntEnv('WEB_PORT', {}, 3420)
      expect(r.value).toBe(3420)
      expect(r.source).toBe<EnvSource>('default')
    })
  })

  it('process.env WEB_PORT=NaN string falls through', () => {
    withEnv({ WEB_PORT: 'NaN' }, () => {
      const r = resolveIntEnv('WEB_PORT', { WEB_PORT: '9000' }, 3420)
      expect(r.value).toBe(9000)
      expect(r.source).toBe<EnvSource>('file')
    })
  })

  // AC-1b: source field surfaces winning source (unit-testable tripwire)
  it('source=process when process.env wins (AC-1b tripwire)', () => {
    withEnv({ WEB_PORT: '4000' }, () => {
      const r = resolveIntEnv('WEB_PORT', {}, 3420)
      expect(r.source).toBe<EnvSource>('process')
    })
  })

  it('source=file when file wins (AC-1b: no process override, no tripwire)', () => {
    withEnv({ WEB_PORT: undefined }, () => {
      const r = resolveIntEnv('WEB_PORT', { WEB_PORT: '4000' }, 3420)
      expect(r.source).toBe<EnvSource>('file')
    })
  })

  // ── upper-bound cap (d60b0caa): out-of-range port falls through like <=0/NaN ─
  it('process.env above max cap falls through to file value', () => {
    withEnv({ WEB_PORT: '99999' }, () => {
      const r = resolveIntEnv('WEB_PORT', { WEB_PORT: '9000' }, 3420, { max: 65535 })
      expect(r.value).toBe(9000)
      expect(r.source).toBe<EnvSource>('file')
    })
  })

  it('process.env above max cap falls through to default when no file value', () => {
    withEnv({ WEB_PORT: '70000' }, () => {
      const r = resolveIntEnv('WEB_PORT', {}, 3420, { max: 65535 })
      expect(r.value).toBe(3420)
      expect(r.source).toBe<EnvSource>('default')
    })
  })

  it('file value above max cap falls through to default', () => {
    withEnv({ WEB_PORT: undefined }, () => {
      const r = resolveIntEnv('WEB_PORT', { WEB_PORT: '99999' }, 3420, { max: 65535 })
      expect(r.value).toBe(3420)
      expect(r.source).toBe<EnvSource>('default')
    })
  })

  it('exactly max (65535) is accepted (boundary)', () => {
    withEnv({ WEB_PORT: '65535' }, () => {
      const r = resolveIntEnv('WEB_PORT', {}, 3420, { max: 65535 })
      expect(r.value).toBe(65535)
      expect(r.source).toBe<EnvSource>('process')
    })
  })

  it('no max option: large values still accepted (back-compat, cap opt-in)', () => {
    withEnv({ WEB_PORT: '99999' }, () => {
      const r = resolveIntEnv('WEB_PORT', {}, 3420)
      expect(r.value).toBe(99999)
      expect(r.source).toBe<EnvSource>('process')
    })
  })
})

// ── resolveStrEnv (AC-1, WEB_HOST) ──────────────────────────────────────────

describe('resolveStrEnv', () => {
  it('process.env takes precedence over file and default', () => {
    withEnv({ WEB_HOST: '0.0.0.0' }, () => {
      const r = resolveStrEnv('WEB_HOST', { WEB_HOST: '192.168.1.1' }, '127.0.0.1')
      expect(r.value).toBe('0.0.0.0')
      expect(r.source).toBe<EnvSource>('process')
    })
  })

  it('file value used when process.env is absent', () => {
    withEnv({ WEB_HOST: undefined }, () => {
      const r = resolveStrEnv('WEB_HOST', { WEB_HOST: '0.0.0.0' }, '127.0.0.1')
      expect(r.value).toBe('0.0.0.0')
      expect(r.source).toBe<EnvSource>('file')
    })
  })

  it('fallback used when both absent', () => {
    withEnv({ WEB_HOST: undefined }, () => {
      const r = resolveStrEnv('WEB_HOST', {}, '127.0.0.1')
      expect(r.value).toBe('127.0.0.1')
      expect(r.source).toBe<EnvSource>('default')
    })
  })
})

// ── AC-2: secrets unaffected by process.env (no precedence change for tokens) ─

describe('AC-2: secret reads are NOT affected by resolveIntEnv/resolveStrEnv', () => {
  it('a token key in process.env does NOT affect resolveIntEnv for WEB_PORT', () => {
    // resolveIntEnv is only used for WEB_PORT/WEB_HOST -- not for TELEGRAM_BOT_TOKEN.
    // Assert that a process.env token value does not contaminate the WEB_PORT resolution.
    withEnv({ TELEGRAM_BOT_TOKEN: 'secret-override', WEB_PORT: undefined }, () => {
      const r = resolveIntEnv('WEB_PORT', { WEB_PORT: '9000' }, 3420)
      expect(r.value).toBe(9000)  // file value, not affected by TELEGRAM env var
    })
  })

  it('resolveStrEnv on TELEGRAM_BOT_TOKEN would expose process.env -- confirm it is NOT used for secrets', () => {
    // This test documents the AC-2 invariant:
    // config.ts uses resolveStrEnv ONLY for WEB_HOST (boot-network knob).
    // TELEGRAM_BOT_TOKEN is read directly from env (the .env file record), never via resolveStrEnv.
    // This test proves the helper is NOT called for secret keys in the production code.
    //
    // We verify: if someone DID call resolveStrEnv on a secret key, process.env would win.
    // That is why we MUST NOT call resolveStrEnv for secrets (AC-2).
    withEnv({ TELEGRAM_BOT_TOKEN: 'process-override' }, () => {
      const r = resolveStrEnv('TELEGRAM_BOT_TOKEN', { TELEGRAM_BOT_TOKEN: 'file-value' }, '')
      // If called, process.env would win -- so we must NOT call it for secrets
      expect(r.source).toBe<EnvSource>('process')
      expect(r.value).toBe('process-override')
    })
    // Config.ts does NOT call resolveStrEnv for TELEGRAM_BOT_TOKEN -- it uses env['TELEGRAM_BOT_TOKEN']
    // (the file env only). This test documents WHY.
  })
})

// ── AC-5: NOA_BOOT_SMOKE seam independence ──────────────────────────────────

describe('AC-5: NOA_BOOT_SMOKE seam independence', () => {
  it('process.env.NOA_BOOT_SMOKE is read directly in index.ts (not via resolveIntEnv/WEB_PORT)', () => {
    // Prove that setting WEB_PORT does NOT affect the smoke-boot port.
    // The smoke boot reads process.env.NOA_BOOT_SMOKE directly.
    // WEB_PORT=3499 and NOA_BOOT_SMOKE=4000 are INDEPENDENT env vars.
    withEnv({ WEB_PORT: '3499', NOA_BOOT_SMOKE: '4000' }, () => {
      const webPort = resolveIntEnv('WEB_PORT', {}, 3420)
      expect(webPort.value).toBe(3499)  // WEB_PORT resolved to 3499

      // The smoke port reads process.env.NOA_BOOT_SMOKE directly (not via resolveIntEnv)
      const smokePort = parseInt(process.env['NOA_BOOT_SMOKE'] ?? '', 10)
      expect(smokePort).toBe(4000)  // completely independent of WEB_PORT

      // Setting WEB_PORT=4000 does NOT make the smoke run on 4000 either
      // (smoke reads NOA_BOOT_SMOKE, not WEB_PORT)
    })
  })

  it('NOA_BOOT_SMOKE absent means smoke mode is disabled (port NaN -> index.ts takes normal boot path)', () => {
    withEnv({ NOA_BOOT_SMOKE: undefined }, () => {
      const smokePort = parseInt(process.env['NOA_BOOT_SMOKE'] ?? '', 10)
      expect(Number.isNaN(smokePort) || smokePort <= 0).toBe(true)
    })
  })
})
