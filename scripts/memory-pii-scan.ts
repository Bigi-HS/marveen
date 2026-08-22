// PM-AC7: retroactive PII scan CLI (card 1dd349bd). Report-only -- NEVER writes.
//
// Before deploying the access_scope migration, run this against the live vault
// to surface rows that match the PM-AC4 PII keyword heuristic but are still
// unscoped (access_scope IS NULL). The report is for MANUAL review: a human
// (Dominik/operator) decides which rows to scope. The scan applies no scopes
// and mutates nothing.
//
//   npx tsx scripts/memory-pii-scan.ts
//
// The output may contain PII keywords -- do NOT commit it to the repo.

import { initDatabase, getDb } from '../src/db.js'
import { scanForUnscopedPII } from '../src/memory-pii-scan.js'

function main(): void {
  initDatabase()
  const matches = scanForUnscopedPII(getDb())
  if (matches.length === 0) {
    console.log('0 rows matched PII patterns -- nothing to review.')
    return
  }
  console.log(`Unscoped rows matching PII patterns: ${matches.length}`)
  console.log('id | agent_id | category | keywords')
  console.log('---|----------|----------|---------')
  for (const m of matches) {
    console.log(`${m.id} | ${m.agent_id} | ${m.category} | ${m.keywords}`)
  }
  console.log('\nReview manually and apply scopes selectively. This script wrote nothing.')
}

main()
