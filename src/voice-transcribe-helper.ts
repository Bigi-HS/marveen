// Pure helpers for voice transcription: command assembly and transcript parsing.
// No subprocess or network calls -- fully unit-testable with DI.

export interface ExecArgs {
  bin: string
  args: string[]
}

export function buildFfmpegArgs(ogaPath: string, wavPath: string): ExecArgs {
  return {
    bin: 'store/whisper-env/env/bin/ffmpeg',
    args: ['-y', '-i', ogaPath, '-ar', '16000', '-ac', '1', wavPath],
  }
}

export function buildWhisperArgs(wavPath: string, outBase: string): ExecArgs {
  return {
    bin: 'store/whisper-env/env/bin/python',
    args: [
      'scripts/_video_transcribe.py',
      '--audio', wavPath,
      '--out-base', outBase,
      '--model', 'medium',
      '--lang', 'hu',
      '--download-root', 'store/whisper-env/models',
    ],
  }
}

// Parse the timestamped .txt output from _video_transcribe.py.
// Each line: "[HH:MM:SS.mmm -> HH:MM:SS.mmm] text"
// Returns the concatenated text segments joined by a single space.
export function parseTranscript(txt: string): string {
  const lineRe = /^\[[^\]]+\]\s*(.*)/
  return txt
    .split('\n')
    .map(line => {
      const m = lineRe.exec(line)
      return m ? m[1].trim() : ''
    })
    .filter(Boolean)
    .join(' ')
}
