import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertSandboxIsolation } from '../sandbox-guard.js'
import { join } from 'node:path'

const PROJECT_ROOT = '/home/project'
const LIVE_DB = join(PROJECT_ROOT, 'store', 'noa.db')
const SANDBOX_DB = join(PROJECT_ROOT, 'store', 'sandbox', 'noa.db')

describe('assertSandboxIsolation', () => {
  const originalEnv = process.env['SANDBOX_ISOLATION']

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['SANDBOX_ISOLATION']
    } else {
      process.env['SANDBOX_ISOLATION'] = originalEnv
    }
  })

  it('no-op when SANDBOX_ISOLATION is unset', () => {
    delete process.env['SANDBOX_ISOLATION']
    expect(() => assertSandboxIsolation(LIVE_DB, PROJECT_ROOT)).not.toThrow()
  })

  it('no-op when SANDBOX_ISOLATION=0', () => {
    process.env['SANDBOX_ISOLATION'] = '0'
    expect(() => assertSandboxIsolation(LIVE_DB, PROJECT_ROOT)).not.toThrow()
  })

  it('no-op when SANDBOX_ISOLATION=1 and DB is sandbox path', () => {
    process.env['SANDBOX_ISOLATION'] = '1'
    expect(() => assertSandboxIsolation(SANDBOX_DB, PROJECT_ROOT)).not.toThrow()
  })

  it('throws when SANDBOX_ISOLATION=1 and DB resolves to live path', () => {
    process.env['SANDBOX_ISOLATION'] = '1'
    expect(() => assertSandboxIsolation(LIVE_DB, PROJECT_ROOT)).toThrow(
      /SANDBOX_ISOLATION=1 but NOA_DB_PATH resolves to the live database/,
    )
  })

  it('throws when resolved path matches live (absolute input)', () => {
    process.env['SANDBOX_ISOLATION'] = '1'
    expect(() => assertSandboxIsolation('/home/project/store/noa.db', PROJECT_ROOT)).toThrow(
      /SANDBOX_ISOLATION=1/,
    )
  })

  it('no-op when SANDBOX_ISOLATION=1 and DB is any other non-live path', () => {
    process.env['SANDBOX_ISOLATION'] = '1'
    const otherDb = join(PROJECT_ROOT, 'store', 'test.db')
    expect(() => assertSandboxIsolation(otherDb, PROJECT_ROOT)).not.toThrow()
  })
})
