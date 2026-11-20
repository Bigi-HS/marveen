import { readBody, json } from '../http-helpers.js'
import { claimContinuityBudget, COMBINED_CONTINUITY_BUDGET } from '../continuity-budget.js'
import type { RouteContext } from './types.js'

// Cross-source SessionStart continuity-budget endpoint (memory-continuity
// Phase 1, S3 hardening -- card 7126a3df).
//
//  POST /api/agent-continuity-budget/:agent/claim
//       Body: { source: string, chars: number }
//       Returns: { allowed: boolean, remaining: number, budget: number }
//
// Called by SessionStart hooks (checkpoint-replay.py, ledger-replay.py,
// memory-replay.py) BEFORE each hook emits its additionalContext. The
// accumulator enforces a single combined hard cap (COMBINED_CONTINUITY_BUDGET)
// across all three sources so the total SessionStart inject stays bounded
// regardless of hook-execution order or marker-stamp failures.
//
// Fail-open protocol: if this endpoint is unavailable, hooks fall back to
// their per-source caps (the existing behavior -- no regression vs. today).
// The endpoint is therefore a HARDENING layer, not a critical path.

export async function tryHandleAgentContinuityBudget(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  const claimMatch = path.match(/^\/api\/agent-continuity-budget\/([^/]+)\/claim$/)
  if (claimMatch && method === 'POST') {
    const agent = decodeURIComponent(claimMatch[1])
    let body: Record<string, unknown>
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw.toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const source = typeof body.source === 'string' ? body.source.trim() : ''
    const chars = typeof body.chars === 'number' ? Math.max(0, Math.floor(body.chars)) : 0
    if (!source) {
      json(res, { error: 'source required' }, 400)
      return true
    }
    const result = claimContinuityBudget(agent, source, chars, Date.now())
    json(res, {
      allowed: result.allowed,
      remaining: result.remaining,
      usedAfter: result.usedAfter,
      budget: COMBINED_CONTINUITY_BUDGET,
    })
    return true
  }

  return false
}
