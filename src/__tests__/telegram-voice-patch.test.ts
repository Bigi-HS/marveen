import { describe, it, expect } from 'vitest'
import { VOICE_PATCH_MARKER, patchVoiceHandler } from '../telegram-voice-patch.js'

// Faithful reproduction of the voice handler block from telegram plugin server.ts v0.0.6 (~830-839).
const ORIGINAL_HANDLER = `bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  const text = ctx.message.caption ?? '(voice message)'
  await handleInbound(ctx, text, undefined, {
    kind: 'voice',
    file_id: voice.file_id,
    size: voice.file_size,
    mime: voice.mime_type,
  })
})`

describe('patchVoiceHandler', () => {
  it('detects and patches the voice handler block', () => {
    const r = patchVoiceHandler(ORIGINAL_HANDLER)
    expect(r.found).toBe(true)
    expect(r.changed).toBe(true)
    expect(r.alreadyPatched).toBe(false)
  })

  it('injects the VOICE_PATCH_MARKER into the output', () => {
    const r = patchVoiceHandler(ORIGINAL_HANDLER)
    expect(r.patched).toContain(VOICE_PATCH_MARKER)
  })

  it('replaces static text with auto-transcription attempt', () => {
    const r = patchVoiceHandler(ORIGINAL_HANDLER)
    // original static fallback is gone as the primary path
    expect(r.patched).not.toContain("const text = ctx.message.caption ?? '(voice message)'")
    // transcription logic is present
    expect(r.patched).toContain('[Hang átirat]:')
    expect(r.patched).toContain('getFile')
  })

  it('preserves the fail-safe fallback to (voice message)', () => {
    const r = patchVoiceHandler(ORIGINAL_HANDLER)
    expect(r.patched).toContain("'(voice message)'")
  })

  it('preserves handleInbound call with the same arguments shape', () => {
    const r = patchVoiceHandler(ORIGINAL_HANDLER)
    expect(r.patched).toContain('handleInbound(ctx, text, undefined, {')
    expect(r.patched).toContain('kind: \'voice\'')
    expect(r.patched).toContain('file_id: voice.file_id')
  })

  it('is idempotent: re-patching an already-patched source is a no-op', () => {
    const once = patchVoiceHandler(ORIGINAL_HANDLER)
    const twice = patchVoiceHandler(once.patched)
    expect(twice.found).toBe(true)
    expect(twice.alreadyPatched).toBe(true)
    expect(twice.changed).toBe(false)
    expect(twice.patched).toBe(once.patched)
  })

  it('fails closed when the voice handler block is absent', () => {
    const unrelated = 'function noop() { return 42 }\n'
    const r = patchVoiceHandler(unrelated)
    expect(r.found).toBe(false)
    expect(r.changed).toBe(false)
    expect(r.patched).toBe(unrelated)
  })

  it('does not log or expose the bot token', () => {
    const r = patchVoiceHandler(ORIGINAL_HANDLER)
    // The patch must never print/log the TOKEN variable value
    expect(r.patched).not.toContain('console.log(TOKEN)')
    expect(r.patched).not.toContain('process.stdout.write(TOKEN)')
    expect(r.patched).not.toContain('stderr.write(TOKEN)')
  })

  it('does not block the event loop (uses async exec, not execFileSync)', () => {
    const r = patchVoiceHandler(ORIGINAL_HANDLER)
    expect(r.patched).not.toContain('execFileSync')
    expect(r.patched).not.toContain('spawnSync')
  })

  it('treats transcript content as untrusted user input (no special escaping bypass)', () => {
    const r = patchVoiceHandler(ORIGINAL_HANDLER)
    // The injected text must flow through handleInbound the same way a text message does --
    // it is prefixed with [Hang átirat]: and handed as the `text` arg, no special wrapper.
    expect(r.patched).toContain('handleInbound(ctx, text, undefined,')
  })
})
