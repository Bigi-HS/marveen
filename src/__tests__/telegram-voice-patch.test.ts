import { describe, it, expect } from 'vitest'
import { VOICE_PATCH_MARKER, patchVoiceHandler } from '../telegram-voice-patch.js'

// Faithful reproduction of the voice handler block from telegram plugin server.ts v0.0.6 (~830-839).
// IMPORTANT: the handler ends with TWO closing lines:
//   line 838:   })       <- indented, closes the handleInbound object arg + call
//   line 839: })         <- column-0, closes the bot.on() callback
// This two-line ending is what the end-anchor `\n\}\)` in VOICE_HANDLER_RE targets.
// A fixture with only one `})` would not catch the under-match bug (Dave review 2026-06-25).
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

  it('produces no leftover closing brace after the handler (no extra `})` from under-match)', () => {
    // The real plugin handler ends with two closing lines:
    //   `  })`  -- indented, closes the handleInbound object arg + call
    //   `})`    -- column-0, closes the bot.on() callback
    // An end-anchor that stops at the indented `  })` leaves a leftover `\n})`, producing
    // three consecutive closing lines (unbalanced) that fail the syntax gate.
    // This test catches that regression by checking the last two non-empty lines exactly.
    const r = patchVoiceHandler(ORIGINAL_HANDLER)
    const nonEmptyLines = r.patched.split('\n').filter(l => l.trim())
    const last2 = nonEmptyLines.slice(-2)
    // Must be: handleInbound-close (indented) then handler-close (column-0), NOT 3x `})`
    expect(last2).toEqual(['  })', '})'])
  })

  it('uses absolute paths for ffmpeg and whisper (plugin CWD is not the project root)', () => {
    const r = patchVoiceHandler(ORIGINAL_HANDLER)
    expect(r.patched).toContain('/home/domin/marveen/store/whisper-env/env/bin/ffmpeg')
    expect(r.patched).toContain('/home/domin/marveen/store/whisper-env/env/bin/python')
    expect(r.patched).toContain('/home/domin/marveen/scripts/_video_transcribe.py')
    expect(r.patched).toContain('/home/domin/marveen/store/whisper-env/models')
    // Must NOT use relative paths
    expect(r.patched).not.toContain("'store/whisper-env/env/bin/ffmpeg'")
    expect(r.patched).not.toContain("'store/whisper-env/env/bin/python'")
    expect(r.patched).not.toContain("'scripts/_video_transcribe.py'")
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
    expect(r.patched).toContain('handleInbound(ctx, text, undefined,')
  })
})
