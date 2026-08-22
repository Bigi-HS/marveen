import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isSecretPointerKey,
  resolveConfigSecrets,
  readAgentConfig,
  SecretPointerError,
} from '../web/agent-config.js'

describe('isSecretPointerKey -- whitelist (card 846aa0ac)', () => {
  it('matches the exact secret-semantic keys, case-insensitively', () => {
    for (const k of ['apiKey', 'api_key', 'token', 'secret', 'clientSecret', 'password', 'webhookUrl']) {
      expect(isSecretPointerKey(k)).toBe(true)
      expect(isSecretPointerKey(k.toUpperCase())).toBe(true)
    }
  })

  it('matches the sensitive suffixes (*Token/*Secret/*ApiKey/*Password)', () => {
    for (const k of ['githubToken', 'openaiApiKey', 'mySecret', 'dbPassword', 'slackWebhookToken']) {
      expect(isSecretPointerKey(k)).toBe(true)
    }
  })

  it('does NOT match human-readable / non-secret fields', () => {
    for (const k of ['displayName', 'name', 'persona', 'model', 'prompt', 'catchphrase',
                     'channelProvider', 'archetype', 'ackCapable', 'securityProfile', 'claudeConfigDir']) {
      expect(isSecretPointerKey(k)).toBe(false)
    }
  })
})

describe('resolveConfigSecrets', () => {
  const SAVED = process.env.MARVEEN_TEST_SECRET
  afterEach(() => {
    if (SAVED === undefined) delete process.env.MARVEEN_TEST_SECRET
    else process.env.MARVEEN_TEST_SECRET = SAVED
  })

  it('resolves a {env:} pointer in a whitelisted key', () => {
    process.env.MARVEEN_TEST_SECRET = 'sk-resolved'
    const out = resolveConfigSecrets({ apiKey: '{env:MARVEEN_TEST_SECRET}' })
    expect(out.apiKey).toBe('sk-resolved')
  })

  it('resolves a {file:} pointer in a whitelisted key (relative to projectRoot)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cfgsec-'))
    try {
      writeFileSync(join(root, 'tok.txt'), 'file-secret\n')
      const out = resolveConfigSecrets({ githubToken: '{file:tok.txt}' }, root)
      expect(out.githubToken).toBe('file-secret') // trailing newline trimmed
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves a plain string untouched even on a whitelisted key', () => {
    const out = resolveConfigSecrets({ token: 'literal-not-a-pointer' })
    expect(out.token).toBe('literal-not-a-pointer')
  })

  it('NEVER touches a non-whitelisted key, even if its value looks like a pointer', () => {
    // The "surprising displayName" case NoA explicitly guarded against.
    const out = resolveConfigSecrets({ displayName: '{env:HOME}', model: '{file:x}' })
    expect(out.displayName).toBe('{env:HOME}')
    expect(out.model).toBe('{file:x}')
  })

  it('ignores non-string values on whitelisted keys', () => {
    const out = resolveConfigSecrets({ token: 42 as unknown as string, secret: true as unknown as string })
    expect(out.token).toBe(42)
    expect(out.secret).toBe(true)
  })

  it('fails closed when a whitelisted pointer is unresolvable', () => {
    delete process.env.MARVEEN_TEST_SECRET
    expect(() => resolveConfigSecrets({ apiKey: '{env:MARVEEN_TEST_SECRET}' })).toThrow(SecretPointerError)
  })

  it('returns a copy and does not mutate the input', () => {
    process.env.MARVEEN_TEST_SECRET = 'v'
    const input = { apiKey: '{env:MARVEEN_TEST_SECRET}', displayName: 'Dave' }
    const out = resolveConfigSecrets(input)
    expect(input.apiKey).toBe('{env:MARVEEN_TEST_SECRET}') // unchanged
    expect(out.apiKey).toBe('v')
    expect(out.displayName).toBe('Dave')
  })
})

describe('readAgentConfig', () => {
  it('returns {} for an agent with no config file', () => {
    expect(readAgentConfig('definitely-no-such-agent-xyz')).toEqual({})
  })
})
