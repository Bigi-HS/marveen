// Types mirroring GET /api/gate/board (src/web/routes/gate-board.ts). Hand-kept in
// sync with the backend payload. The board is a read-only, NON-AUTHORITATIVE
// overview: the real merge path re-runs the gate check, so nothing here gates a
// merge -- it is a display hint (see the backend file header for the full caveat).
// Kept in a dedicated file (not types/api.ts) to keep the gate feature isolated.

export type GateReviewer = 'thor' | 'dave' | 'chad'

/** Per-seat verdict on the latest sha. 'blocked' is sticky (a block wins over a later approve). */
export type GateSeat = 'approved' | 'blocked' | 'none'

export type GateCiStatus = 'pass' | 'fail' | 'none'

/** One PR row in the gate board. Timestamps are epoch SECONDS. */
export interface GateBoardPr {
  pr_number: number
  author: string | null
  seats: Record<GateReviewer, GateSeat>
  ci_status: GateCiStatus
  ci_required: boolean
  override_active: boolean
  /** True once Chad has recorded any verdict on the latest sha. */
  chad_reviewed: boolean
  merge_ready: boolean
  /** Newest recorded gate activity for this PR (epoch SECONDS). */
  last_activity: number
}

export interface GateBoard {
  generated_at: number
  ttl_ms: number
  window_days: number
  prs: GateBoardPr[]
}
