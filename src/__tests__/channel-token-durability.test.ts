import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  channelEnvVaultId,
  shouldUpdateBackup,
  backupChannelEnv,
  restoreChannelEnv,
  type SecretVault,
} from '../web/channel-token-durability.js'

// A fake vault so tests never touch store/vault.json.
function fakeVault(seed: Record<string, string> = {}): SecretVault & { store: Record<string, string> } {
  const store: Record<string, string> = { ...seed }
  return {
    store,
    get: (id) => (id in store ? store[id] : null),
    set: (id, _label, value) => { store[id] = value },
  }
}

describe('channelEnvVaultId', () => {
  it('is a stable, provider-scoped id', () => {
    expect(channelEnvVaultId('dave', 'telegram')).toBe('agent-dave-channel-telegram-env')
    expect(channelEnvVaultId('dave', 'slack')).toBe('agent-dave-channel-slack-env')
  })
})

describe('shouldUpdateBackup', () => {
  it('writes when no backup exists yet', () => {
    expect(shouldUpdateBackup('TELEGRAM_BOT_TOKEN=abc\n', null)).toBe(true)
  })
  it('writes when content changed', () => {
    expect(shouldUpdateBackup('TELEGRAM_BOT_TOKEN=new\n', 'TELEGRAM_BOT_TOKEN=old\n')).toBe(true)
  })
  it('skips when content is unchanged (no vault churn)', () => {
    expect(shouldUpdateBackup('TELEGRAM_BOT_TOKEN=abc\n', 'TELEGRAM_BOT_TOKEN=abc\n')).toBe(false)
  })
  it('never mirrors an empty/whitespace .env', () => {
    expect(shouldUpdateBackup('', null)).toBe(false)
    expect(shouldUpdateBackup('   \n', 'TELEGRAM_BOT_TOKEN=abc\n')).toBe(false)
  })
})

describe('backupChannelEnv / restoreChannelEnv', () => {
  let root: string
  let envPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chan-dur-'))
    envPath = join(root, '.claude', 'channels', 'telegram', '.env')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('backup mirrors a present .env into the vault', () => {
    mkdirSync(join(root, '.claude', 'channels', 'telegram'), { recursive: true })
    writeFileSync(envPath, 'TELEGRAM_BOT_TOKEN=secret123\n')
    const v = fakeVault()
    backupChannelEnv('dave', 'telegram', envPath, v)
    expect(v.store[channelEnvVaultId('dave', 'telegram')]).toBe('TELEGRAM_BOT_TOKEN=secret123\n')
  })

  it('backup is a no-op when the .env is absent', () => {
    const v = fakeVault()
    backupChannelEnv('dave', 'telegram', envPath, v)
    expect(Object.keys(v.store)).toHaveLength(0)
  })

  it('restore re-materialises a missing .env from the vault (mode 0600)', () => {
    const id = channelEnvVaultId('dave', 'telegram')
    const v = fakeVault({ [id]: 'TELEGRAM_BOT_TOKEN=secret123\n' })
    expect(existsSync(envPath)).toBe(false)
    const did = restoreChannelEnv('dave', 'telegram', envPath, v)
    expect(did).toBe(true)
    expect(readFileSync(envPath, 'utf-8')).toBe('TELEGRAM_BOT_TOKEN=secret123\n')
    // 0600: owner rw only
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
  })

  it('restore is a no-op when the .env already exists (never clobbers live token)', () => {
    mkdirSync(join(root, '.claude', 'channels', 'telegram'), { recursive: true })
    writeFileSync(envPath, 'TELEGRAM_BOT_TOKEN=live\n')
    const id = channelEnvVaultId('dave', 'telegram')
    const v = fakeVault({ [id]: 'TELEGRAM_BOT_TOKEN=stale\n' })
    expect(restoreChannelEnv('dave', 'telegram', envPath, v)).toBe(false)
    expect(readFileSync(envPath, 'utf-8')).toBe('TELEGRAM_BOT_TOKEN=live\n')
  })

  it('restore is a no-op when the vault has no backup', () => {
    const v = fakeVault()
    expect(restoreChannelEnv('dave', 'telegram', envPath, v)).toBe(false)
    expect(existsSync(envPath)).toBe(false)
  })

  it('round-trips: backup then restore reproduces the original .env', () => {
    mkdirSync(join(root, '.claude', 'channels', 'telegram'), { recursive: true })
    const original = 'SLACK_BOT_TOKEN=xoxb-1\nSLACK_APP_TOKEN=xapp-1\n'
    writeFileSync(envPath, original)
    const v = fakeVault()
    backupChannelEnv('dave', 'slack', join(root, '.claude', 'channels', 'telegram', '.env'), v)
    rmSync(envPath)
    restoreChannelEnv('dave', 'slack', envPath, v)
    expect(readFileSync(envPath, 'utf-8')).toBe(original)
  })
})
