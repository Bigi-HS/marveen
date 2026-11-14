// Pure helpers for the cost board (card e230c097 slice 2). No IO, no React --
// exported for unit tests so the money/token math is pinned independently of the
// view.
import type { CostAgent } from '@/types/cost'

/** Total tokens across all four components for one agent. */
export function agentTotalTokens(a: CostAgent): number {
  return a.totalInput + a.totalOutput + a.totalCacheRead + a.totalCacheCreation
}

/** Sum of every agent's USD cost (the board total). */
export function totalCostUsd(agents: CostAgent[]): number {
  return agents.reduce((sum, a) => sum + a.totalCostUsd, 0)
}

/** Agents sorted by spend, highest first. Pure (returns a new array). Ties keep
 *  a stable agent-name order so the board render is deterministic. */
export function sortByCost(agents: CostAgent[]): CostAgent[] {
  return [...agents].sort((x, y) => y.totalCostUsd - x.totalCostUsd || x.agent.localeCompare(y.agent))
}

/** Cache-hit ratio in [0,1]: cache-read tokens over all input-side tokens
 *  (cache-read + fresh input). The N1 efficiency signal -- a high ratio means the
 *  agent is re-reading a warm cache rather than re-sending context. 0 when there is
 *  no input-side traffic (avoid a divide-by-zero NaN). */
export function cacheHitRatio(a: CostAgent): number {
  const inputSide = a.totalInput + a.totalCacheRead
  return inputSide > 0 ? a.totalCacheRead / inputSide : 0
}

/** Compact USD formatting: cents under $100, whole dollars under $10k, else $1.2k. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00'
  if (n < 100) return `$${n.toFixed(2)}`
  if (n < 10_000) return `$${Math.round(n).toLocaleString('en-US')}`
  return `$${(n / 1000).toFixed(1)}k`
}

/** Compact token count: 1234 -> "1.2k", 1_200_000 -> "1.2M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n || 0)))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
