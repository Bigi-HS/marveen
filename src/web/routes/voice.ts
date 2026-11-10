// Voice transcription endpoint (Phase 2F, card ad290bf2)
//
// POST /api/voice/transcribe
//   Body: { audioBase64: string, mimeType: string }
//   Returns: { ok: boolean, text: string } | { ok: false, error: string }
//
// Transcription is handled via faster-whisper Python package (CPU, tiny model).
// If faster-whisper is unavailable the endpoint returns ok:false instead of 500
// so the frontend can degrade gracefully.
//
// Auth: any authenticated identity required.
// Size cap: 10 MB base64 (~7.5 MB audio)

import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBody } from '../http-helpers.js'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

// ---------------------------------------------------------------------------
// Transcriber seam (injectable for tests)
// ---------------------------------------------------------------------------

type TranscribeFn = (audioBuffer: Buffer, mimeType: string) => Promise<string>

let _transcriber: TranscribeFn | null = null
export function __setTranscriber(fn: TranscribeFn | null): void { _transcriber = fn }

// Detect a usable Python interpreter with faster_whisper installed.
function detectPython(): string | null {
  for (const py of ['python3', 'python']) {
    try {
      const out = execFileSync(py, ['-c', 'import faster_whisper; print("ok")'], {
        timeout: 5000,
        encoding: 'utf-8',
        env: { ...process.env },
      })
      if (out.trim() === 'ok') return py
    } catch {
      // try next
    }
  }
  return null
}

// Cached interpreter probe (card 85317b24 flag-3). detectPython() spawns a Python
// subprocess; it was previously called twice per request (availability check +
// transcription), doubling the probe cost and the spurious-failure surface. Probe
// at most once per process. `undefined` = not yet probed; `null` = none found.
let _pythonCmd: string | null | undefined
function detectPythonCached(): string | null {
  if (_pythonCmd === undefined) _pythonCmd = detectPython()
  return _pythonCmd
}
// Test seam: clear the interpreter cache between cases.
export function __resetPythonCache(): void { _pythonCmd = undefined }

// Inline Python script: load model once, transcribe file, print result.
// Using "tiny" model: fast, low RAM, acceptable accuracy for short commands.
const WHISPER_SCRIPT = `
import sys
from faster_whisper import WhisperModel
audio_path = sys.argv[1]
model = WhisperModel("tiny", device="cpu", compute_type="int8")
segments, _ = model.transcribe(audio_path, beam_size=1)
text = " ".join(seg.text.strip() for seg in segments).strip()
print(text)
`

function defaultTranscriber(): TranscribeFn {
  return async (audioBuffer, _mimeType) => {
    const py = detectPythonCached()
    if (!py) throw new Error('faster_whisper not available')

    const tmpIn = join(tmpdir(), `voice-${randomUUID()}.webm`)
    const tmpScript = join(tmpdir(), `whisper-${randomUUID()}.py`)
    try {
      writeFileSync(tmpIn, audioBuffer)
      writeFileSync(tmpScript, WHISPER_SCRIPT)
      const out = execFileSync(py, [tmpScript, tmpIn], {
        timeout: 60_000,
        encoding: 'utf-8',
        env: { ...process.env },
      })
      return out.trim()
    } finally {
      try { unlinkSync(tmpIn) } catch { /* ignored */ }
      try { unlinkSync(tmpScript) } catch { /* ignored */ }
    }
  }
}

function getTranscriber(): TranscribeFn {
  return _transcriber ?? defaultTranscriber()
}

// ---------------------------------------------------------------------------
// Availability check (uses the cached interpreter probe)
// ---------------------------------------------------------------------------

// Test seam: force availability on/off without a real interpreter probe so the
// route tests (mimeType validation, 413 overflow) are deterministic regardless
// of whether faster_whisper is installed in the test host.
let _whisperAvailableOverride: boolean | null = null
export function __setWhisperAvailable(v: boolean | null): void { _whisperAvailableOverride = v }

function isWhisperAvailable(): boolean {
  if (_whisperAvailableOverride !== null) return _whisperAvailableOverride
  return detectPythonCached() !== null
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

const MAX_AUDIO_BYTES = 10 * 1024 * 1024 // 10 MB base64

export async function tryHandleVoice(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, identity } = ctx

  if (!path.startsWith('/api/voice/')) return false

  if (path === '/api/voice/transcribe' && method === 'POST') {
    if (!identity?.agentId) {
      json(res, { ok: false, error: 'authentication required' }, 403)
      return true
    }

    if (!isWhisperAvailable()) {
      json(res, { ok: false, text: '', error: 'whisper not available' })
      return true
    }

    let raw: Buffer
    try {
      raw = await readBody(req, { maxBytes: MAX_AUDIO_BYTES })
    } catch {
      json(res, { ok: false, error: 'request body too large (max 10 MB)' }, 413)
      return true
    }

    let parsed: { audioBase64?: unknown; mimeType?: unknown }
    try {
      parsed = JSON.parse(raw.toString('utf-8'))
    } catch {
      json(res, { ok: false, error: 'invalid JSON' }, 400)
      return true
    }

    if (typeof parsed.audioBase64 !== 'string' || !parsed.audioBase64) {
      json(res, { ok: false, error: 'audioBase64 is required' }, 400)
      return true
    }

    // Validate the client-supplied mimeType (card 85317b24 flag-1). It was
    // previously ignored; while the transcriber content-sniffs the audio (the
    // declared type is advisory), rejecting a non-audio/* type is cheap defense
    // against malformed/misrouted clients and makes the accepted input explicit.
    const mimeType = typeof parsed.mimeType === 'string' && parsed.mimeType ? parsed.mimeType : 'audio/webm'
    if (!/^audio\//i.test(mimeType)) {
      json(res, { ok: false, error: 'mimeType must be an audio/* type' }, 400)
      return true
    }

    let audioBuffer: Buffer
    try {
      audioBuffer = Buffer.from(parsed.audioBase64, 'base64')
    } catch {
      json(res, { ok: false, error: 'invalid base64 audio data' }, 400)
      return true
    }

    if (audioBuffer.length === 0) {
      json(res, { ok: false, error: 'empty audio data' }, 400)
      return true
    }

    try {
      const text = await getTranscriber()(audioBuffer, mimeType)
      json(res, { ok: true, text })
    } catch (err) {
      logger.error({ err }, 'voice/transcribe: transcription error')
      json(res, { ok: false, text: '', error: 'transcription failed' }, 500)
    }
    return true
  }

  return false
}
