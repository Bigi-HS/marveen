import { describe, it, expect, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { writeFileSync, rmSync } from 'node:fs'
import {
  tryHandleHibikiNutrition,
  computeNutritionSummary,
  type NutritionEntry,
} from '../web/routes/hibiki-nutrition.js'

const TEST_FILE = '/tmp/test-hibiki-nutrition.json'

async function call(method: string, fullPath: string) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from([]) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return res
    },
    end(b?: string) {
      captured.body = b ? JSON.parse(b) : undefined
    },
  } as never
  const handled = await tryHandleHibikiNutrition({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

const FIXTURE: NutritionEntry[] = [
  { date: '2026-07-10', logged: true, total_calories: 2000, protein_g: 200, source: 'vision-confirmed' }, // outside 7d window
  { date: '2026-07-12', logged: true, total_calories: 1000, protein_g: 40, source: 'vision-confirmed' },
  { date: '2026-07-14', logged: true, total_calories: 1800, protein_g: 160, source: 'vision-confirmed' },
  { date: '2026-07-15', logged: false }, // explicit skip day -> excluded from stats AND returned entries
  { date: '2026-07-16', logged: true, total_calories: 1400, protein_g: 100, source: 'manual' },
  { date: '2026-07-17', logged: true, total_calories: null, protein_g: null, source: 'estimate' }, // logged but null values
]

afterAll(() => {
  rmSync(TEST_FILE, { force: true })
  delete process.env.HIBIKI_NUTRITION_PATH
})

describe('computeNutritionSummary -- rollup', () => {
  it('windows to [today-(days-1), today] and computes stats over logged===true only', () => {
    const s = computeNutritionSummary(FIXTURE, 7, '2026-07-17')
    expect(s.period_days).toBe(7)
    expect(s.date_from).toBe('2026-07-11')
    expect(s.date_to).toBe('2026-07-17')
    // logged===true in window: 07-12, 07-14, 07-16, 07-17 (07-10 out of window, 07-15 skip)
    expect(s.days_logged).toBe(4)
    expect(s.days_total).toBe(7)
    // avg over non-null logged values: cal (1000+1800+1400)/3=1400 ; prot (40+160+100)/3=100
    expect(s.avg_calories).toBe(1400)
    expect(s.avg_protein_g).toBe(100)
    expect(s.protein_target_g).toBe(180)
    // protein_g < 150: 07-12 (40), 07-16 (100) -> 2 (07-17 null excluded, 07-14 =160 not deficit)
    expect(s.protein_deficit_days).toBe(2)
  })

  it('returns in-window entries (logged !== false) sorted ascending, skip day excluded', () => {
    const s = computeNutritionSummary(FIXTURE, 7, '2026-07-17')
    expect(s.entries.map((e) => e.date)).toEqual(['2026-07-12', '2026-07-14', '2026-07-16', '2026-07-17'])
    expect(s.entries[3]).toEqual({ date: '2026-07-17', total_calories: null, protein_g: null, source: 'estimate' })
  })

  it('yields null averages and zero counts for an empty window', () => {
    const s = computeNutritionSummary(FIXTURE, 7, '2026-01-01')
    expect(s.days_logged).toBe(0)
    expect(s.avg_calories).toBeNull()
    expect(s.avg_protein_g).toBeNull()
    expect(s.protein_deficit_days).toBe(0)
    expect(s.entries).toEqual([])
  })

  it('rounds averages to 2 decimals', () => {
    const entries: NutritionEntry[] = [
      { date: '2026-07-16', logged: true, total_calories: 1690, protein_g: 107 },
      { date: '2026-07-17', logged: true, total_calories: 1067, protein_g: 102 },
    ]
    const s = computeNutritionSummary(entries, 7, '2026-07-17')
    expect(s.avg_calories).toBe(1378.5)
    expect(s.avg_protein_g).toBe(104.5)
  })
})

describe('GET /api/hibiki/nutrition-summary -- routing & validation', () => {
  it('does not handle unrelated paths or non-GET methods', async () => {
    expect((await call('GET', '/api/hibiki/other')).handled).toBe(false)
    expect((await call('POST', '/api/hibiki/nutrition-summary')).handled).toBe(false)
  })

  it('400s on invalid days (non-integer, <1, >30)', async () => {
    process.env.HIBIKI_NUTRITION_PATH = '/tmp/does-not-exist-nutrition.json'
    for (const d of ['0', '31', 'abc', '7.5', '-3']) {
      const r = await call('GET', `/api/hibiki/nutrition-summary?days=${d}`)
      expect(r.status, `days=${d}`).toBe(400)
      expect(r.body.error).toBe('invalid_days')
    }
  })

  it('returns 200 + empty summary when the file is missing (not 404)', async () => {
    process.env.HIBIKI_NUTRITION_PATH = '/tmp/does-not-exist-nutrition.json'
    const r = await call('GET', '/api/hibiki/nutrition-summary?days=7')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body.days_logged).toBe(0)
    expect(r.body.entries).toEqual([])
    expect(r.body.protein_target_g).toBe(180)
  })

  it('reads entries from the configured file and defaults days to 7', async () => {
    writeFileSync(TEST_FILE, JSON.stringify({ entries: FIXTURE }))
    process.env.HIBIKI_NUTRITION_PATH = TEST_FILE
    const r = await call('GET', '/api/hibiki/nutrition-summary')
    expect(r.status).toBe(200)
    expect(r.body.period_days).toBe(7)
    // entries present and shaped; exact days_logged depends on the server's today,
    // so assert structural invariants rather than a date-relative count.
    expect(Array.isArray(r.body.entries)).toBe(true)
    expect(r.body.protein_target_g).toBe(180)
  })
})
