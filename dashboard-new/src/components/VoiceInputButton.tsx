// VoiceInputButton -- Phase 2F, card ad290bf2
//
// Records audio via the browser's MediaRecorder API (no Tauri plugin required)
// and sends it to POST /api/voice/transcribe for faster-whisper transcription.
// Falls back gracefully if the browser doesn't support getUserMedia.

import { useState, useRef, useCallback } from 'react'
import { Mic, MicOff, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { apiPost } from '@/lib/api-app'

type State = 'idle' | 'recording' | 'transcribing' | 'error'

interface Props {
  /** Called with the transcribed text when ready. */
  onTranscript: (text: string) => void
  /** Optional extra CSS classes. */
  className?: string
  /** Aria label for the button. */
  ariaLabel?: string
}

interface TranscribeResponse {
  ok: boolean
  text?: string
  error?: string
}

export function VoiceInputButton({ onTranscript, className, ariaLabel = 'Hang rögzítése' }: Props) {
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const isSupported =
    typeof window !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window.MediaRecorder !== 'undefined'

  const startRecording = useCallback(async () => {
    if (state !== 'idle') return
    setErrorMsg(null)

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setState('error')
      setErrorMsg('Mikrofon-hozzáférés megtagadva')
      return
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : ''

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    chunksRef.current = []
    mediaRecorderRef.current = recorder

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' })
      chunksRef.current = []

      setState('transcribing')
      try {
        const arrayBuffer = await blob.arrayBuffer()
        const bytes = new Uint8Array(arrayBuffer)
        const binary = Array.from(bytes)
          .map((b) => String.fromCharCode(b))
          .join('')
        const audioBase64 = btoa(binary)

        const result = await apiPost<TranscribeResponse>('/api/voice/transcribe', {
          audioBase64,
          mimeType: blob.type,
        })

        if (result.ok && result.text) {
          onTranscript(result.text)
          setState('idle')
        } else {
          setState('error')
          setErrorMsg(result.error ?? 'Átírás sikertelen')
        }
      } catch {
        setState('error')
        setErrorMsg('Hálózati hiba')
      }
    }

    recorder.start()
    setState('recording')
  }, [state, onTranscript])

  const stopRecording = useCallback(() => {
    if (state !== 'recording') return
    mediaRecorderRef.current?.stop()
    // state will transition to 'transcribing' in onstop
  }, [state])

  const handleClick = useCallback(() => {
    if (state === 'recording') {
      stopRecording()
    } else if (state === 'idle' || state === 'error') {
      setState('idle')
      setErrorMsg(null)
      void startRecording()
    }
  }, [state, startRecording, stopRecording])

  if (!isSupported) return null

  const icon =
    state === 'transcribing' ? (
      <Loader2 className="h-4 w-4 animate-spin" />
    ) : state === 'recording' ? (
      <MicOff className="h-4 w-4" />
    ) : (
      <Mic className="h-4 w-4" />
    )

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={state === 'transcribing'}
        aria-label={
          state === 'recording'
            ? 'Felvétel leállítása'
            : state === 'transcribing'
              ? 'Átírás folyamatban...'
              : ariaLabel
        }
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors',
          state === 'recording'
            ? 'border-status-error bg-status-error/10 text-status-error animate-pulse'
            : state === 'transcribing'
              ? 'border-border text-text-muted cursor-not-allowed'
              : state === 'error'
                ? 'border-status-error/40 text-status-error hover:border-status-error'
                : 'border-border text-text-muted hover:border-primary hover:text-primary',
          className,
        )}
      >
        {icon}
      </button>
      {errorMsg && (
        <p className="text-xs text-status-error" role="alert">
          {errorMsg}
        </p>
      )}
    </div>
  )
}
