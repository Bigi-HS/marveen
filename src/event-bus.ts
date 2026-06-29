import { EventEmitter } from 'node:events'
import { logger } from './logger.js'

// Card 7c7ea226 (opencode SSE/event-bus push layer): a single in-process bus.
// db.ts write functions emit dashboard changes here; the /api/events/stream SSE
// route subscribes and forwards them to thin clients (thin-notify: the event
// carries only {type,id,action}, the client re-fetches the affected resource).
//
// Zero dependencies beyond the logger so db.ts can import this with no import
// cycle. In-process only -- the dashboard is a single node server, so a process
// EventEmitter is the whole mechanism.

export type DashboardEventType = 'kanban' | 'message' | 'board' | 'gate'

export interface DashboardEvent {
  /** Which resource family changed; the SSE `event:` topic. */
  type: DashboardEventType
  /** The affected resource id -- the client re-fetches by it (thin-notify). */
  id: string
  /** Optional finer action for client-side handling, e.g. 'created' | 'moved'. */
  action?: string
  /** Intake event payload (AC-7a): card snapshot for orchestrator clarification check. */
  card?: { id: string; title: string; description: string | null; assignee: string | null; priority: string; status: string }
}

const EVENT = 'dashboard-event'

// SSE connections come and go, each adds a listener -- disable the default
// max-listeners warning rather than cap legitimate concurrent dashboards.
const bus = new EventEmitter()
bus.setMaxListeners(0)

/**
 * Broadcast a dashboard change. Never throws: a faulty subscriber must not be
 * able to break the DB write that triggered the emit (each handler is isolated
 * in subscribeDashboardEvents, and this guard is the final backstop).
 */
export function emitDashboardEvent(event: DashboardEvent): void {
  try {
    bus.emit(EVENT, event)
  } catch (err) {
    logger.warn({ err, event }, 'event-bus: emit failed')
  }
}

/**
 * Subscribe to dashboard events. Returns an unsubscribe fn that MUST be called
 * when the consumer (e.g. an SSE connection) goes away, or the listener leaks.
 * The handler is wrapped so one subscriber throwing neither propagates to the
 * emitter nor blocks sibling subscribers.
 */
export function subscribeDashboardEvents(
  handler: (event: DashboardEvent) => void,
): () => void {
  const safe = (event: DashboardEvent): void => {
    try {
      handler(event)
    } catch (err) {
      logger.warn({ err, event }, 'event-bus: subscriber threw')
    }
  }
  bus.on(EVENT, safe)
  return () => {
    bus.off(EVENT, safe)
  }
}

/** Current subscriber count -- introspection for tests and health checks. */
export function dashboardSubscriberCount(): number {
  return bus.listenerCount(EVENT)
}
