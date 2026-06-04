import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'
import { getSecret, setSecret } from './vault.js'
import { logger } from '../logger.js'
import type { ChannelProviderType } from '../channel-provider.js'

// Per-agent channel durability.
//
// A per-agent channel token lives in agents/<name>/.claude/channels/<provider>/.env
// (chmod 600). That path sits INSIDE the agent's scaffold tree, so a full agent
// re-scaffold/rebuild can wipe it, silently killing the agent's channel until
// someone re-provisions the token by hand. The durable, scaffold-independent
// store is the vault (store/vault.json, outside the agent dirs), so we mirror
// the whole .env there and re-materialise it on launch when it has gone missing.
//
// We back up the ENTIRE .env content (not just the parsed token) so multi-token
// providers (Slack: SLACK_BOT_TOKEN + SLACK_APP_TOKEN) survive intact, and the
// restored file is byte-identical to what the operator provisioned.

export function channelEnvVaultId(name: string, provider: ChannelProviderType): string {
  return `agent-${name}-channel-${provider}-env`
}

// Pure: a non-empty .env that differs from the stored mirror is worth writing.
// An empty/whitespace .env is never mirrored (it would clobber a good backup
// with nothing), and an unchanged one is skipped to avoid vault churn.
export function shouldUpdateBackup(currentEnv: string, storedEnv: string | null): boolean {
  return currentEnv.trim().length > 0 && currentEnv !== storedEnv
}

// Minimal vault surface so the IO functions are unit-testable with a fake.
export interface SecretVault {
  get(id: string): string | null
  set(id: string, label: string, value: string): void
}

const realVault: SecretVault = {
  get: getSecret,
  set: (id, label, value) => setSecret(id, label, value),
}

// Mirror the agent's channel .env into the vault. Idempotent and best-effort:
// never throws into the launch path.
export function backupChannelEnv(
  name: string,
  provider: ChannelProviderType,
  envPath: string,
  vault: SecretVault = realVault,
): void {
  try {
    if (!existsSync(envPath)) return
    const content = readFileSync(envPath, 'utf-8')
    const id = channelEnvVaultId(name, provider)
    if (shouldUpdateBackup(content, vault.get(id))) {
      vault.set(id, `${name} ${provider} channel env`, content)
      logger.info({ name, provider }, 'channel .env mirrored to vault (durability)')
    }
  } catch (err) {
    logger.warn({ err, name, provider }, 'channel .env vault backup failed (continuing)')
  }
}

// Re-materialise the agent's channel .env from the vault when it is missing
// (e.g. after a re-scaffold). Returns true only when it actually wrote a file.
// Best-effort: never throws into the launch path.
export function restoreChannelEnv(
  name: string,
  provider: ChannelProviderType,
  envPath: string,
  vault: SecretVault = realVault,
): boolean {
  try {
    if (existsSync(envPath)) return false
    const content = vault.get(channelEnvVaultId(name, provider))
    if (content == null || content.trim().length === 0) return false
    mkdirSync(dirname(envPath), { recursive: true })
    atomicWriteFileSync(envPath, content, { mode: 0o600 })
    logger.info({ name, provider }, 'channel .env restored from vault (durability)')
    return true
  } catch (err) {
    logger.warn({ err, name, provider }, 'channel .env vault restore failed (continuing)')
    return false
  }
}
