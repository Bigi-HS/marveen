/**
 * A-layer tests for the analytics dashboard aggregation (card 54df4c8f).
 * Aggregates stored snapshots into the KPI/trend/table surface -- pure over an
 * in-memory DB, no live token, no network.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  applyAnalyticsMigrations,
  upsertSnapshot,
  type AnalyticsSnapshotRow,
} from '../analytics/storage.js'
import { buildAnalyticsDashboard } from '../web/routes/analytics.js'

let db: ReturnType<typeof Database>

function okYt(date: string, views: number, ctr: number, imp: number, watchRatio: number): AnalyticsSnapshotRow {
  return {
    source: 'youtube',
    period_date: date,
    status: 'ok',
    pulled_at: 1_782_000_000,
    period_from: date,
    period_to: date,
    metrics_json: JSON.stringify({
      watchtime: [{ day: date, minutesWatched: 100, avgViewDuration: 400, views }],
      ctr: [{ videoId: 'v1', impressions: imp, ctr }],
      retention: [{ elapsedRatio: 0, watchRatio, relativePerformance: 1 }],
      traffic: [],
    }),
    reason: null,
    detail: null,
  }
}

function okTw(date: string, followers: number, concurrents: number): AnalyticsSnapshotRow {
  return {
    source: 'twitch',
    period_date: date,
    status: 'ok',
    pulled_at: 1_782_000_000,
    period_from: date,
    period_to: date,
    metrics_json: JSON.stringify({
      followers: { total: followers },
      subscriptions: { total: 10, points: 20 },
      stream: { isLive: true, viewerCount: concurrents, title: 'Stream', startedAt: date },
      videos: [],
    }),
    reason: null,
    detail: null,
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  applyAnalyticsMigrations(db)
})

describe('buildAnalyticsDashboard', () => {
  it('aggregates KPIs, trend arrays and tables from stored snapshots', () => {
    upsertSnapshot(okYt('2026-06-27', 400, 0.05, 10000, 0.5), db)
    upsertSnapshot(okYt('2026-06-28', 500, 0.06, 20000, 0.6), db)
    upsertSnapshot(okTw('2026-06-27', 14000, 200), db)
    upsertSnapshot(okTw('2026-06-28', 14823, 247), db)

    const payload = buildAnalyticsDashboard(db) as any

    // KPI row
    expect(payload.kpi.views_7d).toBe(900)
    expect(payload.kpi.twitch_followers).toBe(14823) // latest snapshot
    expect(payload.kpi.avg_ctr).toBeCloseTo(0.06, 4) // latest snapshot's impression-weighted CTR
    expect(payload.kpi.twitch_avg_concurrents).toBeCloseTo(223.5, 1)
    expect(payload.kpi.avg_retention_pct).toBeGreaterThan(0)

    // Trend arrays (ascending chronological)
    expect(payload.trend.views).toEqual([400, 500])
    expect(payload.trend.twitch_followers).toEqual([14000, 14823])

    // Marketing annotations present for each KPI (spec 3)
    expect(payload.annotations.avg_ctr.meaning).toBeTruthy()
    expect(payload.annotations.twitch_followers.target).toBeTruthy()

    // Tables
    expect(payload.tables.top_videos[0].videoId).toBe('v1')
    expect(payload.tables.last_stream.viewerCount).toBe(247)
  })

  it('surfaces freshness including a failed source, and never throws on empty/error data', () => {
    upsertSnapshot({
      source: 'youtube',
      period_date: '2026-06-28',
      status: 'error',
      pulled_at: 1_782_000_000,
      period_from: null,
      period_to: null,
      metrics_json: null,
      reason: 'quota',
      detail: 'HTTP 429',
    }, db)

    const payload = buildAnalyticsDashboard(db) as any
    expect(payload.freshness.youtube.status).toBe('error')
    expect(payload.freshness.youtube.reason).toBe('quota')
    expect(payload.freshness.twitch).toBeNull()
    // Empty/error data -> zeroed KPIs, no throw.
    expect(payload.kpi.views_7d).toBe(0)
    expect(payload.tables.top_videos).toEqual([])
  })
})
