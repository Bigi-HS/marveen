import type { AgentLiveStatus, KanbanStatus, Priority, AgentHealth } from '@/types/api'

// Named colour mappings (AC-F0-4 requires a named constant, not inline ternaries
// scattered across components). Every value is a Tailwind class that resolves to a
// palette CSS variable -- no inline hex anywhere (INV-3 / AC-G4).

/** AC-F0-4: agent status dot colour. */
export const AGENT_STATUS_DOT: Record<AgentLiveStatus, string> = {
  idle: 'bg-accent', // cyan -- alive & quiet
  busy: 'bg-primary', // orange -- working
  offline: 'bg-neutral', // grey
  error: 'bg-neutral', // grey (AC: offline/error -> neutral)
  unknown: 'bg-border',
}

/** Human label for the status dot (tooltip / a11y). */
export const AGENT_STATUS_LABEL: Record<AgentLiveStatus, string> = {
  idle: 'Idle',
  busy: 'Working',
  offline: 'Offline',
  error: 'Stalled',
  unknown: 'Unknown',
}

/**
 * Normalise the health board's derived status to the AC-F0-4 vocabulary.
 * active -> busy, idle -> idle, stopped -> offline, stalled -> error.
 */
export function liveStatusFromHealth(status: AgentHealth['status']): AgentLiveStatus {
  switch (status) {
    case 'active':
      return 'busy'
    case 'idle':
      return 'idle'
    case 'stopped':
      return 'offline'
    case 'stalled':
      return 'error'
    default:
      return 'unknown'
  }
}

/** An agent needs attention when it is neither idle nor busy (AC-F0-5). */
export function agentNeedsAttention(status: AgentLiveStatus): boolean {
  return status === 'error' || status === 'offline' || status === 'unknown'
}

// Kanban columns in fixed display order (AC-F0-7). 'someday' is intentionally
// excluded from the four-column board.
export const KANBAN_COLUMNS: readonly KanbanStatus[] = ['planned', 'in_progress', 'waiting', 'done']

export const KANBAN_COLUMN_LABEL: Record<KanbanStatus, string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  waiting: 'Waiting',
  done: 'Done',
}

/** AC-T2: column header accent (status token). */
export const KANBAN_COLUMN_ACCENT: Record<KanbanStatus, string> = {
  planned: 'text-status-planned',
  in_progress: 'text-status-in-progress',
  waiting: 'text-status-waiting',
  done: 'text-status-done',
}

/**
 * AC-F0-8 priority badge styling. The spec text says "urgent=red", but the palette
 * (INV-3, hard invariant) has no red token and AC-F0-8 also mandates palette tokens
 * only -- the invariant wins. urgent renders as filled brand-orange (the hottest
 * palette colour); high as outlined orange; normal neutral; low muted. Flagged to
 * Quill as a minor spec note (no red token in store/dashboard-palette-noa.md).
 */
export const PRIORITY_BADGE: Record<Priority, string> = {
  urgent: 'bg-primary text-bg-deep font-semibold',
  high: 'border border-primary text-primary',
  normal: 'border border-border text-neutral',
  low: 'border border-border text-text-muted',
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
}
