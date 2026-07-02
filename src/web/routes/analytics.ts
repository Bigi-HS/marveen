// GET /api/analytics/dashboard -- native 3420 control-plane analytics surface
// (card 54df4c8f, A-layer). This is the DETAILED/PII-near surface; the public
// Artifact only ever gets sanitized aggregates via /api/public-digest (never this).
//
// Reads ONLY the stored analytics_snapshots (populated by the daily pull). No live
// API call, no token read -- this endpoint is pure aggregation over persisted rows,
// so it is fully buildable/testable in the A-layer. When the B-layer starts writing
// real snapshots, this surface renders them unchanged.
//
// Response shape (spec section 3):
//   - kpi:    subs net 7/30d, views 7/30d, avg retention %, avg CTR,
//             twitch followers + avg concurrents  (each with a marketing annotation)
//   - trend:  28-day sparkline arrays for the main 4 KPIs
//   - tables: top YouTube videos, last + next Twitch stream

import { json } from '../http-helpers.js'
import { listRecentSnapshots, type AnalyticsSnapshotRow } from '../../analytics/storage.js'
import type {
  YoutubeMetrics,
  TwitchMetrics,
} from '../../analytics/pull.js'
import type Database from 'better-sqlite3'
import type { RouteContext } from './types.js'

// Marketing annotations (spec 3: "what it means / target band" per KPI). Static
// copy -- the interpretation guide the dashboard shows next to each number.
const KPI_ANNOTATIONS: Record<string, { meaning: string; target: string }> = {
  subs_net: { meaning: 'Net subscriber change (gained minus lost).', target: 'Positive and trending up week over week.' },
  views: { meaning: 'Total video views in the window.', target: 'Steady growth; spikes map to uploads.' },
  avg_retention_pct: { meaning: 'Average % of the video watched.', target: 'Above 40% is healthy for long-form.' },
  avg_ctr: { meaning: 'Impressions click-through rate.', target: '4-10% is a strong thumbnail/title.' },
  twitch_followers: { meaning: 'Total Twitch followers.', target: 'Monotonic growth; watch for stream-day jumps.' },
  twitch_avg_concurrents: { meaning: 'Average concurrent viewers while live.', target: 'Grows with cadence + raid/network effects.' },
}

function parseOkMetrics<M>(rows: AnalyticsSnapshotRow[]): Array<{ date: string; metrics: M }> {
  const out: Array<{ date: string; metrics: M }> = []
  for (const r of rows) {
    if (r.status !== 'ok' || !r.metrics_json) continue
    try {
      out.push({ date: r.period_date, metrics: JSON.parse(r.metrics_json) as M })
    } catch { /* corrupt row -- skip, never throw the endpoint */ }
  }
  return out
}

function sum(ns: number[]): number { return ns.reduce((a, b) => a + b, 0) }
function avg(ns: number[]): number { return ns.length ? sum(ns) / ns.length : 0 }

/**
 * Build the analytics dashboard payload from the last 28 days of snapshots.
 * Pure over the injected db handle so it is unit-testable with an in-memory DB.
 */
export function buildAnalyticsDashboard(db?: Database.Database): unknown {
  const ytRows = listRecentSnapshots('youtube', 28, db)
  const twRows = listRecentSnapshots('twitch', 28, db)

  const yt = parseOkMetrics<YoutubeMetrics>(ytRows)
  const tw = parseOkMetrics<TwitchMetrics>(twRows)

  // Chronological (ascending) for trend arrays; storage returns descending.
  const ytAsc = [...yt].reverse()
  const twAsc = [...tw].reverse()

  // Flatten per-day YouTube watchtime rows across snapshots for windowed views.
  const ytDailyViews = ytAsc.map(s => ({ date: s.date, views: sum(s.metrics.watchtime?.map(w => w.views) ?? []) }))

  const views7d = sum(ytDailyViews.slice(-7).map(d => d.views))
  const views30d = sum(ytDailyViews.map(d => d.views))

  // Retention: average of per-snapshot mean audienceWatchRatio (as a %).
  const retentionPerSnap = ytAsc.map(s => avg((s.metrics.retention ?? []).map(r => r.watchRatio)) * 100)
  const avgRetentionPct = avg(retentionPerSnap.slice(-7))

  // CTR: impression-weighted mean across the latest snapshot's ctr rows.
  const latestYt = ytAsc[ytAsc.length - 1]
  const ctrRows = latestYt?.metrics.ctr ?? []
  const totalImp = sum(ctrRows.map(c => c.impressions))
  const avgCtr = totalImp > 0 ? sum(ctrRows.map(c => c.ctr * c.impressions)) / totalImp : 0

  // Twitch KPIs.
  const twFollowers = twAsc.map(s => s.metrics.followers?.total ?? 0)
  const twitchFollowers = twFollowers[twFollowers.length - 1] ?? 0
  const twConcurrents = twAsc
    .map(s => s.metrics.stream?.viewerCount)
    .filter((v): v is number => typeof v === 'number')
  const twitchAvgConcurrents = avg(twConcurrents)

  // Trend sparklines (28 days) for the main 4 KPIs.
  const trend = {
    views: ytDailyViews.map(d => d.views),
    retention_pct: retentionPerSnap,
    ctr: ytAsc.map(s => {
      const rows = s.metrics.ctr ?? []
      const imp = sum(rows.map(c => c.impressions))
      return imp > 0 ? sum(rows.map(c => c.ctr * c.impressions)) / imp : 0
    }),
    twitch_followers: twFollowers,
  }

  // Tables.
  const topVideos = (latestYt?.metrics.ctr ?? [])
    .slice()
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 5)
    .map(v => ({ videoId: v.videoId, impressions: v.impressions, ctr: v.ctr }))

  const latestTw = twAsc[twAsc.length - 1]
  const lastStream = latestTw?.metrics.stream
    ? {
        isLive: latestTw.metrics.stream.isLive,
        title: latestTw.metrics.stream.title,
        startedAt: latestTw.metrics.stream.startedAt,
        viewerCount: latestTw.metrics.stream.viewerCount,
      }
    : null

  // Data-freshness flags so the surface can show a stale/failed source banner.
  const ytLatest = ytRows[0]
  const twLatest = twRows[0]

  return {
    generated_at: Math.floor(Date.now() / 1000),
    freshness: {
      youtube: ytLatest ? { status: ytLatest.status, period_date: ytLatest.period_date, pulled_at: ytLatest.pulled_at, reason: ytLatest.reason } : null,
      twitch: twLatest ? { status: twLatest.status, period_date: twLatest.period_date, pulled_at: twLatest.pulled_at, reason: twLatest.reason } : null,
    },
    kpi: {
      subs_net_7d: 0, // net subs deltas require subscribersGained/Lost daily rows (B-layer wires the daily YT report); 0 until then.
      subs_net_30d: 0,
      views_7d: views7d,
      views_30d: views30d,
      avg_retention_pct: Number(avgRetentionPct.toFixed(2)),
      avg_ctr: Number(avgCtr.toFixed(4)),
      twitch_followers: twitchFollowers,
      twitch_avg_concurrents: Number(twitchAvgConcurrents.toFixed(1)),
    },
    annotations: KPI_ANNOTATIONS,
    trend,
    tables: {
      top_videos: topVideos,
      last_stream: lastStream,
      next_stream: null, // scheduled-stream API is a B-layer add; no A-layer source.
    },
  }
}

export async function tryHandleAnalytics(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== '/api/analytics/dashboard' || method !== 'GET') return false
  json(res, buildAnalyticsDashboard())
  return true
}
