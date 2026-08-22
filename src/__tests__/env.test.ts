import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseEnvValue } from '../env.js'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..', '..')
const testEnvPath = join(PROJECT_ROOT, '.env')

let hadExistingEnv = false
let existingContent = ''

beforeEach(() => {
  if (existsSync(testEnvPath)) {
    hadExistingEnv = true
    existingContent = require('fs').readFileSync(testEnvPath, 'utf-8')
  }
})

afterEach(() => {
  if (hadExistingEnv) {
    writeFileSync(testEnvPath, existingContent)
  } else {
    try { unlinkSync(testEnvPath) } catch {}
  }
})

describe('readEnvFile', () => {
  it('ures objektumot ad vissza ha nincs .env', async () => {
    try { unlinkSync(testEnvPath) } catch {}
    // Friss import
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result).toEqual({})
  })

  it('kulcs-ertek parokat parszol', async () => {
    writeFileSync(testEnvPath, 'FOO=bar\nBAZ=qux\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['FOO']).toBe('bar')
    expect(result['BAZ']).toBe('qux')
  })

  it('idezojeleket kezel', async () => {
    writeFileSync(testEnvPath, 'KEY="value with spaces"\nKEY2=\'single\'\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['KEY']).toBe('value with spaces')
    expect(result['KEY2']).toBe('single')
  })

  it('kommenteket atugorja', async () => {
    writeFileSync(testEnvPath, '# komment\nKEY=val\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['KEY']).toBe('val')
    expect(Object.keys(result)).toHaveLength(1)
  })

  it('szurt kulcsokat ad vissza ha megadva', async () => {
    writeFileSync(testEnvPath, 'A=1\nB=2\nC=3\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile(['A', 'C'])
    expect(result['A']).toBe('1')
    expect(result['C']).toBe('3')
    expect(result['B']).toBeUndefined()
  })
})

describe('parseEnvValue (pure .env value parse)', () => {
  it('extracts a simple KEY=value', () => {
    expect(parseEnvValue('TELEGRAM_BOT_TOKEN=abc123\n', 'TELEGRAM_BOT_TOKEN')).toBe('abc123')
  })

  it('returns null when the key is absent', () => {
    expect(parseEnvValue('OTHER=1\n', 'TELEGRAM_BOT_TOKEN')).toBeNull()
  })

  it('anchors to line start: a prefixed var does not satisfy the request', () => {
    // MY_TELEGRAM_BOT_TOKEN= must NOT match a request for TELEGRAM_BOT_TOKEN=
    expect(parseEnvValue('MY_TELEGRAM_BOT_TOKEN=wrong\n', 'TELEGRAM_BOT_TOKEN')).toBeNull()
  })

  it('picks the real anchored line even when a prefixed decoy precedes it', () => {
    const content = 'MY_TELEGRAM_BOT_TOKEN=wrong\nTELEGRAM_BOT_TOKEN=right\n'
    expect(parseEnvValue(content, 'TELEGRAM_BOT_TOKEN')).toBe('right')
  })

  it('excludes an inline comment from the value', () => {
    expect(parseEnvValue('GITHUB_PAT=ghp_abc # my token\n', 'GITHUB_PAT')).toBe('ghp_abc')
  })

  it('stops the value at the first whitespace', () => {
    expect(parseEnvValue('GITHUB_PAT=ghp_abc def\n', 'GITHUB_PAT')).toBe('ghp_abc')
  })

  it('treats the key name literally, not as a regex', () => {
    expect(parseEnvValue('A.B=x\n', 'A.B')).toBe('x')
    expect(parseEnvValue('AXB=y\n', 'A.B')).toBeNull()
  })
})

describe('readEnvValue (file-backed)', () => {
  it('reads a value from the .env file', async () => {
    writeFileSync(testEnvPath, 'GITHUB_PAT=ghp_fromfile\n')
    const { readEnvValue } = await import('../env.js')
    expect(readEnvValue('GITHUB_PAT')).toBe('ghp_fromfile')
  })

  it('returns null when the .env file is absent', async () => {
    try { unlinkSync(testEnvPath) } catch {}
    const { readEnvValue } = await import('../env.js')
    expect(readEnvValue('GITHUB_PAT')).toBeNull()
  })
})
