import { useEffect, useRef, useState } from 'react'

// F1 realtime layer (card 513b8fd6). A single multiplexed SSE connection to the
// backend event bus (GET /api/events/stream, built in card 7c7ea226). The server
// frames are THIN-NOTIFY -- {type, id, action} only -- so this hook reads just
// the event TYPE and bumps a per-type revision counter; it never consumes frame
// content. Consumers watch a revision as a refetch trigger (the actual data is
// re-pulled through the existing authed/redacted GET endpoints), so the SSE is a
// trigger, not a content channel (the F1 egress posture).
//
// Auth: same-origin EventSource through the vite proxy sends the HttpOnly session
// cookie automatically (withCredentials), so no Authorization header / token-in-URL
// is needed (verified live: the :3421 preview proxy streams frames incrementally).

export type DashboardEventType = 'kanban' | 'message' | 'board' | 'gate'

const STREAM_PATH = '/api/events/stream'
const EVENT_TYPES: DashboardEventType[] = ['kanban', 'message', 'board', 'gate']

// Coalesce a write-burst (dispatch+move+comment emit several events) into one
// revision bump so the SSE + safety poll never create a fetch-storm (mirrors the
// legacy dashboard client's makeCoalescer, card 7c7ea226 build-note #1).
const COALESCE_MS = 120
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000

export const __TESTING = { COALESCE_MS, BASE_BACKOFF_MS, MAX_BACKOFF_MS }

export type Revisions = Record<DashboardEventType, number>

export interface EventStreamState {
  connected: boolean
  revisions: Revisions
}

function zeroRevisions(): Revisions {
  return { kanban: 0, message: 0, board: 0, gate: 0 }
}

export function useEventStream(): EventStreamState {
  const [connected, setConnected] = useState(false)
  const [revisions, setRevisions] = useState<Revisions>(zeroRevisions)

  // All mutable connection state lives in refs so the effect runs once (no
  // reconnect storm from re-renders) and the cleanup sees the live handles.
  const esRef = useRef<EventSource | null>(null)
  const backoffRef = useRef(BASE_BACKOFF_MS)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const coalesceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<Set<DashboardEventType>>(new Set())
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true

    const flushPending = (): void => {
      coalesceTimerRef.current = null
      if (pendingRef.current.size === 0) return
      const types = [...pendingRef.current]
      pendingRef.current.clear()
      setRevisions((prev) => {
        const next = { ...prev }
        for (const t of types) next[t] = prev[t] + 1
        return next
      })
    }

    const scheduleFlush = (): void => {
      if (coalesceTimerRef.current != null) return
      coalesceTimerRef.current = setTimeout(flushPending, COALESCE_MS)
    }

    const connect = (): void => {
      if (!aliveRef.current) return
      const es = new EventSource(STREAM_PATH, { withCredentials: true })
      esRef.current = es

      es.onopen = (): void => {
        if (!aliveRef.current) return
        backoffRef.current = BASE_BACKOFF_MS // healthy connection -> reset backoff
        setConnected(true)
      }

      es.onerror = (): void => {
        if (!aliveRef.current) return
        setConnected(false)
        try { es.close() } catch { /* already gone */ }
        // Exponential backoff, capped. A fresh connection is scheduled once.
        if (reconnectTimerRef.current != null) return
        const wait = backoffRef.current
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS)
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null
          connect()
        }, wait)
      }

      // Subscribe by named topic (the server sets the SSE `event:` field to the
      // type). We read only the type -> bump its revision; frame data is ignored.
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, () => {
          if (!aliveRef.current) return
          pendingRef.current.add(type)
          scheduleFlush()
        })
      }
    }

    connect()

    return () => {
      aliveRef.current = false
      if (reconnectTimerRef.current != null) clearTimeout(reconnectTimerRef.current)
      if (coalesceTimerRef.current != null) clearTimeout(coalesceTimerRef.current)
      reconnectTimerRef.current = null
      coalesceTimerRef.current = null
      try { esRef.current?.close() } catch { /* already gone */ }
      esRef.current = null
    }
  }, [])

  return { connected, revisions }
}
