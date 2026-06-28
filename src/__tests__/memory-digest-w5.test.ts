// W5-1 regression guard: runDailyDigest must keep producing a daily summary on
// the slim noa.db schema and write it via appendDailyLog (NOT the retired
// saveMemory('episodic') path), so it is retrievable through the daily-log
// read path (recallByDateRange == /api/daily-log). marveen AC 2026-06-28:
// "daily-summary behavior MUST be preserved, no silent function loss."
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// Mock the LLM sub-agent so the digest is deterministic and no real agent spawns.
const DIGEST_TEXT = 'Teszt napi osszefoglalo: feladatokon dolgoztunk, dontesek szulettek.'
vi.mock('../agent.js', () => ({
  runAgent: vi.fn(async () => ({ text: DIGEST_TEXT })),
}))

import { runDailyDigest } from '../memory.js'
import {
  initNoaDb,
  getNoaDb,
  appendDailyLog,
  recallByDateRange,
  getDailyLogDates,
} from '../noa-memory.js'
import { MAIN_AGENT_ID } from '../config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

function seedMemory(agentId: string, content: string, ageSeconds: number): void {
  const now = Math.floor(Date.now() / 1000)
  getNoaDb().prepare(
    "INSERT INTO memories (agent_id, category, content, keywords, created_at, accessed_at) VALUES (?, 'hot', ?, NULL, ?, ?)"
  ).run(agentId, content, now - ageSeconds, now - ageSeconds)
}

function todayDateStr(): string {
  return new Date().toISOString().split('T')[0]
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
})

beforeEach(() => {
  getNoaDb().prepare('DELETE FROM memories').run()
  getNoaDb().prepare('DELETE FROM daily_logs').run()
})

describe('W5-1 runDailyDigest -> appendDailyLog (daily-summary preserved)', () => {
  it('writes the digest to the daily log, retrievable via the daily-log read path', async () => {
    seedMemory(MAIN_AGENT_ID, 'reggel: A feladat elindult', 3600)
    seedMemory(MAIN_AGENT_ID, 'delben: B dontes meghozva', 1800)

    const digest = await runDailyDigest()
    expect(digest).toBe(DIGEST_TEXT)

    // The summary must land in daily_logs (NOT in memories as 'episodic').
    const today = todayDateStr()
    const result = recallByDateRange(today, today, MAIN_AGENT_ID)
    expect(result.logs.length).toBe(1)
    expect(result.logs[0].content).toContain(DIGEST_TEXT)
    expect(getDailyLogDates(MAIN_AGENT_ID)).toContain(today)

    // No 'episodic' memory row should be created (legacy category is gone).
    const episodic = getNoaDb()
      .prepare("SELECT COUNT(*) c FROM memories WHERE content LIKE '%Napi naplo%'")
      .get() as { c: number }
    expect(episodic.c).toBe(0)
  })

  it('skips (returns null) when fewer than 2 of today memories exist, writing no log', async () => {
    seedMemory(MAIN_AGENT_ID, 'csak egy mai emlek', 600)
    seedMemory(MAIN_AGENT_ID, 'tegnapi emlek', 90000) // older than 24h -> excluded

    const digest = await runDailyDigest()
    expect(digest).toBeNull()

    const today = todayDateStr()
    const result = recallByDateRange(today, today, MAIN_AGENT_ID)
    expect(result.logs.length).toBe(0)
  })

  it('appendDailyLog round-trips independently (sanity)', () => {
    appendDailyLog(MAIN_AGENT_ID, 'kozvetlen napi bejegyzes')
    const today = todayDateStr()
    const result = recallByDateRange(today, today, MAIN_AGENT_ID)
    expect(result.logs.some((l) => l.content.includes('kozvetlen napi bejegyzes'))).toBe(true)
  })
})
