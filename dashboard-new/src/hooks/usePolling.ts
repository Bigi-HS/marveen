import { useEffect, useRef, useState } from 'react'
import { apiGet } from '@/lib/api'

export interface PollState<T> {
  data: T | null
  error: Error | null
  loading: boolean
}

/**
 * Poll a read-only GET endpoint on an interval (F0 has no SSE yet -- that lands
 * in F1). Fires immediately, then every `intervalMs`. Aborts the in-flight request
 * on unmount and skips state updates after unmount. GET-only by construction
 * (apiGet), so no mutation can leak through this hook (AC-G2).
 */
export function usePolling<T>(path: string, intervalMs = 5000): PollState<T> {
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
  }, [path, intervalMs])

  return state
}
