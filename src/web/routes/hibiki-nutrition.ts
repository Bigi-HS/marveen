// GET /api/hibiki/nutrition-summary -- read-only nutrition rollup from the Hibiki
// agent's nutrition_log.json (card cd2bd7b9, n8n Tier-A). Mirrors bond-srs.ts: the
// executeCommand-disabled n8n instance reads this loopback REST endpoint on a
// schedule (08:30) and alerts Dominik when avg_protein_g is low.
//
// Source is a FILE, not a DB. A missing file is a normal "nothing logged yet"
// state (200 + empty), NOT a 404. The `days` window is [today-(days-1), today],
// anchored on the Europe/Budapest calendar day (fleet timezone rule).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const DEFAULT_DAYS = 7
const MAX_DAYS = 30
const PROTEIN_TARGET_G = 180
// Alert threshold is intentionally below the target: the n8n workflow pings only
// when protein falls under this floor, not merely under the aspirational target.
const PROTEIN_DEFICIT_THRESHOLD_G = 150

export interface NutritionEntry {
  date: string
  logged?: boolean
  total_calories?: number | null
  protein_g?: number | null
  source?: string | null
}

export interface NutritionSummary {
  period_days: number
  date_from: string
  date_to: string
  days_logged: number
  days_total: number
  avg_calories: number | null
  avg_protein_g: number | null
  protein_target_g: number
  protein_deficit_days: number
  entries: Array<{ date: string; total_calories: number | null; protein_g: number | null; source: string | null }>
}

function nutritionPath(): string {
  return process.env.HIBIKI_NUTRITION_PATH || join(PROJECT_ROOT, 'agents/hibiki/store/nutrition_log.json')
}

// Today's date on the Europe/Budapest calendar as YYYY-MM-DD (en-CA formats ISO).
function budapestToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Budapest' }).format(new Date())
}

function isoMinusDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - n)
  return dt.toISOString().slice(0, 10)
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return round2(values.reduce((a, b) => a + b, 0) / values.length)
}

// File read is best-effort: a missing file, unreadable file, or malformed JSON all
// degrade to "no entries" so the endpoint stays 200 (an empty summary), never 5xx.
export function readNutritionEntries(): NutritionEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(nutritionPath(), 'utf-8')) as { entries?: unknown }
    return Array.isArray(parsed?.entries) ? (parsed.entries as NutritionEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Pure rollup over the raw entries. `todayISO` is injected for deterministic
 * tests. The returned `entries` list keeps every in-window entry that was not
 * explicitly un-logged (logged !== false); the averages/counts are computed only
 * over explicitly logged days (logged === true) so a placeholder skip day never
 * drags the mean.
 */
export function computeNutritionSummary(entries: NutritionEntry[], days: number, todayISO: string): NutritionSummary {
  const dateTo = todayISO
  const dateFrom = isoMinusDays(todayISO, days - 1)

  const inWindow = entries.filter((e) => e.date >= dateFrom && e.date <= dateTo)
  const returned = inWindow.filter((e) => e.logged !== false)
  const logged = inWindow.filter((e) => e.logged === true)

  const cals = logged.map((e) => e.total_calories).filter((v): v is number => typeof v === 'number')
  const prots = logged.map((e) => e.protein_g).filter((v): v is number => typeof v === 'number')

  return {
    period_days: days,
    date_from: dateFrom,
    date_to: dateTo,
    days_logged: logged.length,
    days_total: days,
    avg_calories: mean(cals),
    avg_protein_g: mean(prots),
    protein_target_g: PROTEIN_TARGET_G,
    protein_deficit_days: logged.filter(
      (e) => typeof e.protein_g === 'number' && e.protein_g < PROTEIN_DEFICIT_THRESHOLD_G,
    ).length,
    entries: returned
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => ({
        date: e.date,
        total_calories: e.total_calories ?? null,
        protein_g: e.protein_g ?? null,
        source: e.source ?? null,
      })),
  }
}

export async function tryHandleHibikiNutrition(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (path !== '/api/hibiki/nutrition-summary' || method !== 'GET') return false

  let days = DEFAULT_DAYS
  const raw = url.searchParams.get('days')
  if (raw !== null) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) {
      json(res, { error: 'invalid_days', message: `days must be an integer between 1 and ${MAX_DAYS}` }, 400)
      return true
    }
    days = n
  }

  json(res, computeNutritionSummary(readNutritionEntries(), days, budapestToday()))
  return true
}
