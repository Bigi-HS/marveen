import { describe, it, expect } from 'vitest'
import { channelIntentFromEnabledPlugins } from '../channel-provider.js'

// Behavioral tests for the shared channel-intent decision. This pure function
// is the single source of truth behind both agent-process.isAgentChannelInten-
// tionallyEnabled (the channel-monitor auto-recovery gate) and the agent-preflight
// channelIntentEnabled fact, so it must classify every channel state correctly.
describe('channelIntentFromEnabledPlugins', () => {
  it('returns false when enabledPlugins is null/undefined', () => {
    expect(channelIntentFromEnabledPlugins(null, 'telegram')).toBe(false)
    expect(channelIntentFromEnabledPlugins(undefined, 'telegram')).toBe(false)
  })

  it('returns false for an empty plugin map', () => {
    expect(channelIntentFromEnabledPlugins({}, 'telegram')).toBe(false)
  })

  it('returns true when the provider plugin is enabled (namespaced key)', () => {
    expect(
      channelIntentFromEnabledPlugins({ 'telegram@claude-plugins-official': true }, 'telegram'),
    ).toBe(true)
  })

  it('returns false when the provider plugin is explicitly disabled', () => {
    // This is the channel-less launch case the launcher force-writes; it must
    // NOT be eligible for auto-recovery (the death-loop guard).
    expect(
      channelIntentFromEnabledPlugins({ 'telegram@claude-plugins-official': false }, 'telegram'),
    ).toBe(false)
  })

  it('isolates providers: a telegram-enabled map is false for slack/discord', () => {
    const ep = { 'telegram@claude-plugins-official': true }
    expect(channelIntentFromEnabledPlugins(ep, 'slack')).toBe(false)
    expect(channelIntentFromEnabledPlugins(ep, 'discord')).toBe(false)
  })

  it('matches slack and discord on their namespaced keys', () => {
    expect(
      channelIntentFromEnabledPlugins({ 'slack-channel@marveen-marketplace': true }, 'slack'),
    ).toBe(true)
    expect(
      channelIntentFromEnabledPlugins({ 'discord@claude-plugins-official': true }, 'discord'),
    ).toBe(true)
  })

  it('treats only literal boolean true as enabled (not truthy strings)', () => {
    expect(
      channelIntentFromEnabledPlugins({ 'telegram@claude-plugins-official': 'true' as unknown as boolean }, 'telegram'),
    ).toBe(false)
    expect(
      channelIntentFromEnabledPlugins({ 'telegram@claude-plugins-official': 1 as unknown as boolean }, 'telegram'),
    ).toBe(false)
  })

  it('returns true if any matching provider key is true among several', () => {
    expect(
      channelIntentFromEnabledPlugins(
        {
          'telegram@claude-plugins-official': false,
          'telegram@some-other-marketplace': true,
        },
        'telegram',
      ),
    ).toBe(true)
  })
})
