import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  readAgentChannelProviderSafe,
  readAgentChannelProvider,
  agentDir,
} from '../web/agent-config.js'
import { resolveAgentProviderType } from '../web/channel-mcp-reconnect.js'
import { subAgentChannelState } from '../web/agent-health.js'
import { CHANNEL_PROVIDER } from '../config.js'

// Card fab9e7f9 (#190 Chad INFO[low] follow-up): readAgentChannelProvider reads
// through the secret-pointer resolving loader, which throws SecretPointerError
// fail-closed on a misconfigured pointer (a {file:} to a missing file, an unset
// {env:}). The 8 launch/health/monitor callers must NOT crash agent startup on
// such a config -- they read through readAgentChannelProviderSafe, which never
// throws and flags `misconfigured` instead. A bad secret pointer in a
// whitelisted key (apiToken) is the trigger; channelProvider itself is not a
// secret and is left untouched.

// Throwaway agent dirs under the real AGENTS_BASE_DIR so agentDir/safeJoin
// resolve them exactly as the launch path will. Cleaned up after each test.
const OK_NAME = `__chan_safe_ok_${process.pid}`
const NONE_NAME = `__chan_safe_none_${process.pid}`
const BAD_NAME = `__chan_safe_bad_${process.pid}`

function writeConfig(name: string, config: unknown): void {
  const dir = agentDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(config))
}

afterEach(() => {
  for (const n of [OK_NAME, NONE_NAME, BAD_NAME]) {
    rmSync(agentDir(n), { recursive: true, force: true })
  }
})

describe('readAgentChannelProviderSafe -- fail-soft channel-provider read', () => {
  it('returns the provider with misconfigured=false for a well-formed config', () => {
    writeConfig(OK_NAME, { channelProvider: 'telegram' })
    expect(readAgentChannelProviderSafe(OK_NAME)).toEqual({ provider: 'telegram', misconfigured: false })
  })

  it('returns provider=null, misconfigured=false for a channel-less agent', () => {
    writeConfig(NONE_NAME, { displayName: 'No Channel' })
    expect(readAgentChannelProviderSafe(NONE_NAME)).toEqual({ provider: null, misconfigured: false })
  })

  it('returns misconfigured=true (never throws) when a whitelisted secret pointer is unresolvable', () => {
    // apiToken is a whitelisted secret key; an unset {env:} pointer is fail-closed
    // in resolveConfigSecrets -> readAgentConfig -> readAgentChannelProvider throws.
    writeConfig(BAD_NAME, { channelProvider: 'telegram', apiToken: '{env:__UNSET_TEST_VAR_DAVE_XYZ__}' })
    // sanity: the raw (throwing) reader does propagate the error here
    expect(() => readAgentChannelProvider(BAD_NAME)).toThrow()
    const safe = readAgentChannelProviderSafe(BAD_NAME)
    expect(safe.misconfigured).toBe(true)
    expect(safe.provider).toBeNull()
    expect(typeof safe.error).toBe('string')
  })
})

describe('caller-hardening -- launch/health callers fail soft, never throw', () => {
  it('resolveAgentProviderType falls back to the default provider for a misconfigured agent', () => {
    writeConfig(BAD_NAME, { channelProvider: 'telegram', apiToken: '{env:__UNSET_TEST_VAR_DAVE_XYZ__}' })
    let result: string | undefined
    expect(() => { result = resolveAgentProviderType(BAD_NAME) }).not.toThrow()
    expect(result).toBe(CHANNEL_PROVIDER)
  })

  it('subAgentChannelState surfaces misconfigured=true and falls back the provider', () => {
    writeConfig(BAD_NAME, { channelProvider: 'telegram', apiToken: '{env:__UNSET_TEST_VAR_DAVE_XYZ__}' })
    let state: ReturnType<typeof subAgentChannelState> | undefined
    expect(() => { state = subAgentChannelState(BAD_NAME) }).not.toThrow()
    expect(state?.misconfigured).toBe(true)
    expect(state?.provider).toBe(CHANNEL_PROVIDER)
  })

  it('subAgentChannelState reports misconfigured=false for a clean config', () => {
    writeConfig(OK_NAME, { channelProvider: 'telegram' })
    const state = subAgentChannelState(OK_NAME)
    expect(state.misconfigured).toBe(false)
    expect(state.provider).toBe('telegram')
  })
})
