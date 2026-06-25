// Pure transform for voice-in auto-transcription (card 45478ca7).
//
// The Telegram channel plugin delivers inbound voice messages as the static string
// "(voice message)" + a file_id attachment. CLAUDE.md promises that voice messages
// arrive as "[Hang átirat]: <text>" so every agent can handle them as plain text.
//
// This patch replaces the bot.on('message:voice') handler with a version that:
//   1. Downloads the .oga file from Telegram's file API (async, non-blocking).
//   2. Converts to 16 kHz mono WAV with ffmpeg (store/whisper-env/env/bin/ffmpeg).
//   3. Transcribes with faster-whisper (store/whisper-env/env/bin/python).
//   4. Injects "[Hang átirat]: <text>" as the message content before handleInbound.
//
// Fail-safe: any error in steps 1-3 is silently caught and the original
// "(voice message)" string is used instead -- a voice message is NEVER lost.
//
// Security: the transcript is untrusted user input and flows through handleInbound
// unchanged, the same boundary as all other inbound text. TOKEN is never logged.
//
// The transform anchors on the stable code tokens of the handler block and is
// idempotent via VOICE_PATCH_MARKER.

export const VOICE_PATCH_MARKER = '[voice-transcribe-patch]'

export interface PatchResult {
  patched: string
  // true if the target handler block (or the marker) was located.
  found: boolean
  // true if this call modified the source.
  changed: boolean
  // true if the source already carried the patch.
  alreadyPatched: boolean
}

// Matches the entire message:voice handler block, anchored on code tokens
// that are stable across plugin prose/message wording changes.
const VOICE_HANDLER_RE =
  /bot\.on\('message:voice',\s*async ctx => \{[\s\S]*?const text = ctx\.message\.caption \?\? '\(voice message\)'[\s\S]*?\}\)/

const REPLACEMENT = `bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  // ${VOICE_PATCH_MARKER} auto-transcribe inbound voice before delivery.
  // Fail-safe: any error falls back to '(voice message)' -- never drops the message.
  let text = ctx.message.caption ?? '(voice message)'
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const execFileAsync = promisify(execFile)

    const fileInfo = await ctx.api.getFile(voice.file_id)
    if (fileInfo.file_path) {
      const url = \`https://api.telegram.org/file/bot\${TOKEN}/\${fileInfo.file_path}\`
      const res = await fetch(url)
      if (res.ok) {
        const dir = mkdtempSync(join(tmpdir(), 'noa-voice-'))
        try {
          const ogaPath = join(dir, 'in.oga')
          const wavPath = join(dir, 'in.wav')
          const outBase = join(dir, 'out')
          writeFileSync(ogaPath, Buffer.from(await res.arrayBuffer()))
          await execFileAsync(
            'store/whisper-env/env/bin/ffmpeg',
            ['-y', '-i', ogaPath, '-ar', '16000', '-ac', '1', wavPath],
            { stdio: 'ignore' } as Parameters<typeof execFile>[2],
          )
          await execFileAsync(
            'store/whisper-env/env/bin/python',
            [
              'scripts/_video_transcribe.py',
              '--audio', wavPath,
              '--out-base', outBase,
              '--model', 'medium',
              '--lang', 'hu',
              '--download-root', 'store/whisper-env/models',
            ],
          )
          const raw = readFileSync(outBase + '.txt', 'utf-8')
          const transcript = raw
            .split('\\n')
            .map((line: string) => { const m = /^\\[[^\\]]+\\]\\s*(.*)/.exec(line); return m ? m[1].trim() : '' })
            .filter(Boolean)
            .join(' ')
          if (transcript) text = \`[Hang átirat]: \${transcript}\`
        } finally {
          try { rmSync(dir, { recursive: true, force: true }) } catch {}
        }
      }
    }
  } catch {
    // fail-safe: keep original text
  }
  await handleInbound(ctx, text, undefined, {
    kind: 'voice',
    file_id: voice.file_id,
    size: voice.file_size,
    mime: voice.mime_type,
  })
})`

export function patchVoiceHandler(src: string): PatchResult {
  if (src.includes(VOICE_PATCH_MARKER)) {
    return { patched: src, found: true, changed: false, alreadyPatched: true }
  }
  if (!VOICE_HANDLER_RE.test(src)) {
    return { patched: src, found: false, changed: false, alreadyPatched: false }
  }
  const patched = src.replace(VOICE_HANDLER_RE, REPLACEMENT)
  return { patched, found: true, changed: patched !== src, alreadyPatched: false }
}
