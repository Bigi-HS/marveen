import { useEffect, useRef, useState } from 'react'
import { apiGet } from '@/lib/api'

export interface PollState<T> {
  data: T | null
  error: Error | null
  loading: boolean
}

export interface PollOptions {
  /** Safety-backstop poll interval. With SSE driving freshness (F1), this is a
   *  slow backstop (default 30s), not the primary refresh path. */
  intervalMs?: number
  /** A monotonically changing value (e.g. a useEventStream revision). Each change
   *  forces an immediate refetch -- this is how an SSE event refreshes the data
   *  without waiting for the interval. */
  refreshSignal?: number
}

const DEFAULT_INTERVAL_MS = 30_000

function normalizeOpts(opts?: number | PollOptions): Required<Pick<PollOptions, 'intervalMs'>> & { refreshSignal?: number } {
  // Back-compat: a bare number is the legacy intervalMs positional arg.
  if (typeof opts === 'number') return { intervalMs: opts }
  return { intervalMs: opts?.intervalMs ?? DEFAULT_INTERVAL_MS, refreshSignal: opts?.refreshSignal }
}

/**
 * Read-only GET poller with SSE-driven refetch (F1, card 513b8fd6). Fires
 * immediately, then every `intervalMs` as a backstop, AND whenever `refreshSignal`
 * changes (an SSE event bumped it). Aborts the in-flight request on unmount and
 * skips state updates after unmount. GET-only by construction (apiGet), so no
 * mutation can leak through this hook (AC-G2).
 */
export function usePolling<T>(path: string, opts?: number | PollOptions): PollState<T> {
  const { intervalMs, refreshSignal } = normalizeOpts(opts)
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, loading: true })
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    let controller: AbortController | null = null

    const tick = async (): Promise<void> => {
      controller?.abort()
      controller = new AbortController()
      try {
        const data = await apiGet<T>(path, controller.signal)
        if (aliveRef.current) setState({ data, error: null, loading: false })
      } catch (err) {
        if (controller.signal.aborted) return
        if (aliveRef.current) {
          setState((prev) => ({ data: prev.data, error: err as Error, loading: false }))
        }
      }
    }

    void tick()
    const id = setInterval(() => void tick(), intervalMs)
    return () => {
      aliveRef.current = false
      controller?.abort()
      clearInterval(id)
    }
    // refreshSignal in deps: a change re-runs the effect -> immediate refetch.
  }, [path, intervalMs, refreshSignal])

  return state
}
