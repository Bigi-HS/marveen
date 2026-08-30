import { describe, it, expect, vi, beforeEach } from 'vitest'

const written: Record<string, string> = {}
const readable: Record<string, string> = {}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((p: string, enc?: unknown) => {
      const key = String(p)
      if (key in readable) {
        if (readable[key] === '__ENOENT__') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return readable[key]
      }
      return actual.readFileSync(p as string, enc as BufferEncoding)
    }) as typeof actual.readFileSync,
    writeFileSync: ((p: string, data: string) => {
      written[String(p)] = data
    }) as typeof actual.writeFileSync,
  }
})

import { syncDeployedTip } from '../deployed-tip.js'

describe('syncDeployedTip', () => {
  beforeEach(() => {
    Object.keys(written).forEach((k) => delete written[k])
    Object.keys(readable).forEach((k) => delete readable[k])
  })

  it('copies dist/.built-from to store/.deployed-tip', () => {
    readable['/repo/dist/.built-from'] = 'abc123def456\n'
    syncDeployedTip('/repo')
    expect(written['/repo/store/.deployed-tip']).toBe('abc123def456\n')
  })

  it('trims and normalises SHA before writing', () => {
    readable['/repo/dist/.built-from'] = '  deadbeef1234  \n'
    syncDeployedTip('/repo')
    expect(written['/repo/store/.deployed-tip']).toBe('deadbeef1234\n')
  })

  it('does not throw when dist/.built-from is missing', () => {
    readable['/repo/dist/.built-from'] = '__ENOENT__'
    expect(() => syncDeployedTip('/repo')).not.toThrow()
    expect(written['/repo/store/.deployed-tip']).toBeUndefined()
  })

  it('does not throw when dist/.built-from is empty', () => {
    readable['/repo/dist/.built-from'] = '   '
    expect(() => syncDeployedTip('/repo')).not.toThrow()
    expect(written['/repo/store/.deployed-tip']).toBeUndefined()
  })
})
