import { describe, it, expect, afterEach, vi } from 'vitest'
import { join, isAbsolute } from 'node:path'
import { SERVER_BOOT_AT_PATH } from '../server-boot-path.js'

// Card cc871848: single source of truth for the server boot-timestamp path,
// shared by web.ts (writer) and delivery-ack-cli.ts (reader) so the literal
// cannot drift between them. Lives in a side-effect-free module so web.ts can
// import it without pulling in the CLI's top-level main().
describe('SERVER_BOOT_AT_PATH', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('points at store/.fleet-supervisor/server-boot-at.txt under an absolute root', () => {
    expect(isAbsolute(SERVER_BOOT_AT_PATH)).toBe(true)
    expect(SERVER_BOOT_AT_PATH.endsWith(join('store', '.fleet-supervisor', 'server-boot-at.txt'))).toBe(true)
  })

  it('honors the MARVEEN_ROOT override (parity with delivery-ack-cli resolution)', async () => {
    vi.stubEnv('MARVEEN_ROOT', '/tmp/test-root-xyz')
    vi.resetModules()
    const { SERVER_BOOT_AT_PATH: overridden } = await import('../server-boot-path.js')
    expect(overridden).toBe(join('/tmp/test-root-xyz', 'store', '.fleet-supervisor', 'server-boot-at.txt'))
  })
})
