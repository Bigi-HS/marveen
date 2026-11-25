// Shared test helper (M3 FK-ON, card ff80db66 / 26ba217a).
//
// schema-noa.sql now declares agents-FKs on memories.agent_id,
// agent_messages.from_agent, agent_tokens.agent_id and kanban_cards.assignee
// (P3). Fixtures that build a fresh DB from schema-noa.sql and insert
// agent-owned rows must therefore seed the referenced agent_ids into the
// `agents` dim-table first, or the enforced FK (foreign_keys=ON in noa-db.ts /
// db.ts) rejects the insert.
//
// These legacy unit fixtures are NOT testing FK enforcement; they exercise
// kanban / memory / scheduler logic and insert rows under a small set of
// well-known agent_ids (the live fleet roster plus a handful of placeholder
// ids). This helper seeds that superset idempotently right after the schema is
// applied, restoring the pre-FK "insert freely" behavior without weakening the
// FK contract (which is proven by scripts/__tests__/schema-noa-fk.test.py and
// scripts/__tests__/fk-on.test.py).
import type Database from 'better-sqlite3'

// Live fleet roster + the placeholder/synthetic ids these fixtures use as
// agent_id / assignee / from_agent. Keep additive: a new fixture id simply gets
// added here. Order-insensitive; all seeded with INSERT OR IGNORE.
const TEST_AGENT_IDS: readonly string[] = [
  // live fleet
  'marveen', 'dave', 'scout', 'forge', 'quill', 'devil-advocate', 'radar',
  'gauge', 'thor', 'chad', 'big-ben', 'bond', 'hibiki', 'claudia', 'percy',
  'gyore', 'applegate', 'buster', 'genesis', 'noa', 'dominik',
  // historical / de-brand fallbacks seen in fixtures
  'legacy', 'system',
  // single-letter + placeholder ids used across kanban/memory fixtures
  'a', 'b', 'c', 'd', 'x', 'y', 'z',
  'root', 'other', 'original', 'samu', 'zara', 'kidd', 'rackham', 'morgan',
  'some-agent', 'nonexistent-agent', 'test-agent', 'test-leak-1', 'test-main',
  'park1', 'pre-dispatched', 'owner1', 'owner2', 'agent1', 'agent2',
]

/**
 * Seed the agents dim-table so FK-constrained inserts in legacy fixtures
 * resolve. Idempotent (INSERT OR IGNORE); safe to call after every
 * schema-noa.sql load. Pass extra ids for fixtures that mint unusual agent_ids.
 */
export function seedTestAgents(db: Database.Database, extra: readonly string[] = []): void {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO agents (agent_id, display, created_at) VALUES (?, ?, ?)'
  )
  const seed = db.transaction((ids: readonly string[]) => {
    for (const id of ids) stmt.run(id, id, 1)
  })
  seed([...TEST_AGENT_IDS, ...extra])
}
