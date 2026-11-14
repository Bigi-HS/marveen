// Types mirroring GET /api/token-usage/cost (src/web/routes/token-usage.ts +
// src/web/token-usage.ts). Hand-kept in sync with the backend payload. Read-only
// observability: the per-job cost board (card e230c097 slice 2) surfaces the N1
// token-discipline as a measured per-agent spend view. Kept in a dedicated file
// to keep the cost feature isolated from types/api.ts.

/** Per-agent cost+token rollup (backend TokenSummary). Timestamps epoch SECONDS. */
export interface CostAgent {
  agent: string
  totalCalls: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  firstSeen: number
  lastSeen: number
  /** Cache-aware USD, priced per-row by model (card bb4992dc). */
  totalCostUsd: number
}

/** One-level parent->child (phantom orchestration) cost rollup (backend LineageRollup). */
export interface CostLineage {
  parent: string
  childCalls: number
  childSessions: number
  childCostUsd: number
}

/** A model whose rows could not be priced (unknown/renamed) -- a visible gap, not a silent $0. */
export interface CostUnrated {
  agent: string
  model: string | null
  calls: number
  totalTokens: number
}

export interface CostBoard {
  agents: CostAgent[]
  lineage: CostLineage[]
  unrated: CostUnrated[]
}
