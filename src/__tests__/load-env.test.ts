import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyEnvContent, loadEnvFile } from '../load-env.js'

describe('applyEnvContent (card 46b3bd75 .env loader)', () => {
  it('sets a missing key from KEY=VALUE', () => {
    const env: NodeJS.ProcessEnv = {}
    const set = applyEnvContent('NOA_DB_PATH=store/noa.db', env)
    expect(env['NOA_DB_PATH']).toBe('store/noa.db')
    expect(set).toEqual(['NOA_DB_PATH'])
  })

  it('REAL ENV WINS: never overwrites an existing key', () => {
    const env: NodeJS.ProcessEnv = { NOA_DB_PATH: 'store/claudeclaw.db' }
    const set = applyEnvContent('NOA_DB_PATH=store/noa.db', env)
    expect(env['NOA_DB_PATH']).toBe('store/claudeclaw.db') // unchanged
    expect(set).toEqual([]) // nothing set
  })

  it('treats an empty-string existing value as defined (not overwritten)', () => {
    const env: NodeJS.ProcessEnv = { FOO: '' }
    applyEnvContent('FOO=bar', env)
    expect(env['FOO']).toBe('') // '' !== undefined -> real env wins
  })

  it('skips blank lines, comments, and malformed lines', () => {
    const env: NodeJS.ProcessEnv = {}
    const set = applyEnvContent('\n# a comment\n  # indented comment\nNOTAKEYVALUE\n=noKey\nGOOD=1\n', env)
    expect(set).toEqual(['GOOD'])
    expect(env['GOOD']).toBe('1')
  })

  it('preserves "=" inside the value', () => {
    const env: NodeJS.ProcessEnv = {}
    applyEnvContent('URL=https://x/y?a=b&c=d', env)
    expect(env['URL']).toBe('https://x/y?a=b&c=d')
  })

  it('strips a matching pair of surrounding quotes', () => {
    const env: NodeJS.ProcessEnv = {}
    applyEnvContent('A="quoted"\nB=\'single\'\nC="unbalanced', env)
    expect(env['A']).toBe('quoted')
    expect(env['B']).toBe('single')
    expect(env['C']).toBe('"unbalanced') // unbalanced -> left as-is
  })

  it('rejects non-identifier keys (e.g. leading digit, dashes)', () => {
    const env: NodeJS.ProcessEnv = {}
    const set = applyEnvContent('1BAD=x\nBAD-KEY=y\nOK_KEY=z', env)
    expect(set).toEqual(['OK_KEY'])
  })

  it('returns key NAMES only, never values (no-secret-leak contract)', () => {
    const env: NodeJS.ProcessEnv = {}
    const set = applyEnvContent('SECRET_TOKEN=supersecretvalue', env)
    expect(set).toEqual(['SECRET_TOKEN'])
    expect(set.join()).not.toContain('supersecretvalue')
  })

  it('defaults to process.env when no env arg is given', () => {
    const key = 'NOA_LOADENV_TEST_' + 'X'
    delete process.env[key]
    applyEnvContent(`${key}=1`)
    expect(process.env[key]).toBe('1')
    delete process.env[key]
  })
})

describe('loadEnvFile', () => {
  it('reads and applies a real .env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loadenv-'))
    try {
      const p = join(dir, '.env')
      writeFileSync(p, 'NOA_DB_PATH=store/noa.db\nFOO=bar\n')
      const env: NodeJS.ProcessEnv = { FOO: 'keep' }
      const set = loadEnvFile(p, env)
      expect(set).toEqual(['NOA_DB_PATH']) // FOO already set -> skipped
      expect(env['NOA_DB_PATH']).toBe('store/noa.db')
      expect(env['FOO']).toBe('keep')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a graceful no-op for a missing file (never throws)', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(() => loadEnvFile('/no/such/path/.env', env)).not.toThrow()
    expect(loadEnvFile('/no/such/path/.env', env)).toEqual([])
    expect(Object.keys(env)).toEqual([])
  })

  it('is a graceful no-op for a directory path (read error -> [])', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loadenv-'))
    try {
      const env: NodeJS.ProcessEnv = {}
      expect(loadEnvFile(dir, env)).toEqual([]) // EISDIR caught
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
