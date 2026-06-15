// PM-AC7: retroactive PII scan core (card 1dd349bd). Report-only -- never writes.
// The thin CLI wrapper lives in scripts/memory-pii-scan.ts.

import { getDb, isPotentialPII } from './db.js'

export interface PiiScanRow {
  id: number
  agent_id: string
  category: string
  keywords: string
}

type DbHandle = ReturnType<typeof getDb>

// Pure: SELECTs unscoped rows and filters by the shared PII heuristic. No writes.
export function scanForUnscopedPII(db: DbHandle): PiiScanRow[] {
  const rows = db
    .prepare(
      'SELECT id, agent_id, category, keywords, content FROM memories WHERE access_scope IS NULL',
    )
    .all() as { id: number; agent_id: string; category: string; keywords: string | null; content: string }[]
  return rows
    .filter((r) => isPotentialPII(r.keywords, r.content))
    .map((r) => ({
      id: r.id,
      agent_id: r.agent_id,
      category: r.category,
      keywords: (r.keywords ?? '').slice(0, 60),
    }))
}
