// Response shapes of the existing :3420 backend. Hand-typed from the route
// handlers (src/web/routes/*.ts + src/db.ts) -- the new UI only READS these in
// F0+F1, never mutates. Timestamps: kanban + messages are epoch SECONDS; the
// health *Ts fields are epoch MILLISECONDS (noted per field).

/** GET /api/agents -- canonical agent roster. */
export interface AgentSummary {
  name: string
  displayName: string
  description: string
  model: string
  activeModel: string | null
  running: boolean
  hasAvatar: boolean
  status: 'configured' | 'draft'
  contextPercent: number | null
}

/** Derived live status (per AC-F0-4), normalised from the health board. */
export type AgentLiveStatus = 'idle' | 'busy' | 'offline' | 'error' | 'unknown'

/** GET /api/agents/health -- fleet health board (one record per agent). */
export interface AgentHealth {
  name: string
  isMain: boolean
  alive: boolean
  /** epoch MILLISECONDS, last produced output, or null */
  lastProgressTs: number | null
  /** epoch MILLISECONDS, last channel ingestion, or null */
  lastInboundTs: number | null
  status: 'stopped' | 'idle' | 'active' | 'stalled'
}

export type KanbanStatus = 'planned' | 'in_progress' | 'waiting' | 'done'
export type Priority = 'low' | 'normal' | 'high' | 'urgent'

/** GET /api/kanban -- card rows (epoch SECONDS timestamps). */
export interface KanbanCard {
  id: string
  seq?: number
  title: string
  description: string | null
  status: KanbanStatus | 'someday'
  assignee: string | null
  priority: Priority
  project: string | null
  parent_id: string | null
  due_date: number | null
  created_at: number
  updated_at: number
  dispatched_at: number | null
}

/** GET /api/messages?limit=N -- inter-agent activity (epoch SECONDS). */
export interface AgentMessage {
  id: number
  from_agent: string
  to_agent: string
  content: string
  status: 'pending' | 'delivered' | 'done' | 'failed'
  priority: Priority
  created_at: number
  delivered_at: number | null
}

/** View model produced by joining the roster with the health board. */
export interface AgentGridItem {
  name: string
  displayName: string
  status: AgentLiveStatus
  /** epoch MILLISECONDS, or null when never active */
  lastActiveTs: number | null
  hasAvatar: boolean
  isMain: boolean
}

/**
 * GET /api/tool-log -- recent tool-call log rows (card 229a9000 hook-event relay).
 * Timestamps are epoch SECONDS; `success` is a 0|1 int (SQLite boolean).
 */
export interface ToolCallEvent {
  id: number
  session_id: string
  tool_name: string
  input_summary: string | null
  success: number
  created_at: number
}
