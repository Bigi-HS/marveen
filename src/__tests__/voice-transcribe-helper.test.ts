import { describe, it, expect } from 'vitest'
import { parseTranscript, buildFfmpegArgs, buildWhisperArgs } from '../voice-transcribe-helper.js'

describe('parseTranscript', () => {
  it('extracts text from timestamped lines and joins with space', () => {
    const txt = '[00:00:00.000 -> 00:00:03.000] Hello, ez egy teszt.\n[00:00:03.000 -> 00:00:05.000] Második mondat.\n'
    expect(parseTranscript(txt)).toBe('Hello, ez egy teszt. Második mondat.')
  })

  it('trims leading/trailing whitespace from each segment', () => {
    const txt = '[00:00:00.000 -> 00:00:02.000]   trimmed  \n'
    expect(parseTranscript(txt)).toBe('trimmed')
  })

  it('returns empty string for empty input', () => {
    expect(parseTranscript('')).toBe('')
  })

  it('returns empty string when no timestamped lines match', () => {
    expect(parseTranscript('no timestamps here\njust plain text\n')).toBe('')
  })

  it('handles a single line without trailing newline', () => {
    const txt = '[00:00:00.000 -> 00:00:01.000] Single.'
    expect(parseTranscript(txt)).toBe('Single.')
  })

  it('skips blank segments (empty text after bracket)', () => {
    const txt = '[00:00:00.000 -> 00:00:01.000] \n[00:00:01.000 -> 00:00:02.000] actual text\n'
    expect(parseTranscript(txt)).toBe('actual text')
  })

  it('handles multi-segment voice message correctly', () => {
    const lines = [
      '[00:00:00.000 -> 00:00:02.500] Szia,',
      '[00:00:02.500 -> 00:00:04.000] hogy vagy?',
    ].join('\n')
    expect(parseTranscript(lines)).toBe('Szia, hogy vagy?')
  })
})

describe('buildFfmpegArgs', () => {
  it('returns the correct binary path and conversion arguments', () => {
    const { bin, args } = buildFfmpegArgs('/tmp/voice/in.oga', '/tmp/voice/in.wav')
    expect(bin).toBe('store/whisper-env/env/bin/ffmpeg')
    expect(args).toEqual(['-y', '-i', '/tmp/voice/in.oga', '-ar', '16000', '-ac', '1', '/tmp/voice/in.wav'])
  })

  it('uses the provided paths verbatim (no normalisation)', () => {
    const { args } = buildFfmpegArgs('/a/b.oga', '/c/d.wav')
    expect(args).toContain('/a/b.oga')
    expect(args).toContain('/c/d.wav')
  })
})

describe('buildWhisperArgs', () => {
  it('returns the correct binary path and whisper arguments', () => {
    const { bin, args } = buildWhisperArgs('/tmp/voice/in.wav', '/tmp/voice/out')
    expect(bin).toBe('store/whisper-env/env/bin/python')
    expect(args).toEqual([
      'scripts/_video_transcribe.py',
      '--audio', '/tmp/voice/in.wav',
      '--out-base', '/tmp/voice/out',
      '--model', 'medium',
      '--lang', 'hu',
      '--download-root', 'store/whisper-env/models',
    ])
  })

  it('uses the provided paths verbatim', () => {
    const { args } = buildWhisperArgs('/x/y.wav', '/x/y')
    expect(args).toContain('/x/y.wav')
    expect(args).toContain('/x/y')
  })
})
