import { subscribeDashboardEvents, type DashboardEvent } from '../../event-bus.js'
import type { RouteContext } from './types.js'

// Card 7c7ea226 (opencode SSE/event-bus push layer): the single multiplexed
// dashboard event stream. db.ts write functions emit kanban/message changes on
// the in-process bus; this endpoint forwards them to every connected client as
// SSE. Thin-notify -- the frame carries only {type,id,action}, the client
// re-fetches the affected resource. Topic goes in the SSE `event:` field so a
// client can route by type. Mirrors the existing pane-stream SSE in
// agent-terminal.ts (headers, ?token= auth handled in web.ts, req-close cleanup).

// A comment line every 25s keeps proxies/load-balancers from idling the
// connection out. A FAILED heartbeat write means the socket is half-dead (a
// proxy cut it without delivering a close event) -- tear down so the bus
// listener does not leak (NoA build-note #2).
const HEARTBEAT_MS = 25_000

/** Frame a dashboard event as an SSE message. Exported for tests. */
export function formatSseEvent(event: DashboardEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export async function tryHandleEvents(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/events/stream' || method !== 'GET') return false

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  let closed = false
  let unsubscribe: () => void = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const stop = (): void => {
    if (closed) return
    closed = true
    unsubscribe()
    if (heartbeat) clearInterval(heartbeat)
    try { res.end() } catch { /* already torn down */ }
  }

  unsubscribe = subscribeDashboardEvents((event) => {
    if (closed) return
    try {
      res.write(formatSseEvent(event))
    } catch {
      stop() // socket gone mid-write
    }
  })

  // Initial comment so the client's onopen fires promptly and proxies flush.
  try {
    res.write(': connected\n\n')
  } catch {
    stop()
    return true
  }

  heartbeat = setInterval(() => {
    if (closed) return
    try {
      res.write(': heartbeat\n\n')
    } catch {
      stop() // half-dead socket with no close event
    }
  }, HEARTBEAT_MS)
  // Don't let the heartbeat timer keep the process alive on shutdown.
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  req.on('close', stop)
  req.on('error', stop)
  return true
}
