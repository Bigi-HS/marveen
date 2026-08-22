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
import {
  aggregateCtrByFormat,
  peakAvgConcurrentLabel,
  affiliateHoursLabel,
  retainedViewsScore,
  DEFAULT_IMPRESSION_FLOOR,
  type FormatTaggedCtrRow,
} from '../../analytics/labels.js'
import type { YtTrafficBucket } from '../../analytics/youtube.js'
import type {
  YoutubeMetrics,
  TwitchMetrics,
} from '../../analytics/pull.js'
import type Database from 'better-sqlite3'
import type { RouteContext } from './types.js'

// Marketing annotations (spec 3: "what it means / target band" per KPI). Static
// copy -- the interpretation guide the dashboard shows next to each number.
// Target bands are Radar's small-channel-calibrated, devil-advocate-cleared values
// (data-gate PR#354, store/datagate-pr354-54df4c8f.md), NOT platform averages.
const KPI_ANNOTATIONS: Record<string, { meaning: string; target: string }> = {
  subs_net: { meaning: 'Net subscriber change (gained minus lost).', target: 'Trend-based, not absolute: net-positive weekly; a breakout video should accelerate it.' },
  views: { meaning: 'Total video views in the window.', target: 'Steady growth; spikes map to uploads.' },
  avg_retention_pct: { meaning: 'Average % of the video watched. First-60s retention is the key hook-health signal (correlative, not causal).', target: '>=45% acceptable, >=50% good, >=60% strong. Flag: high 60s + falling full-video retention = clickbait (session penalty).' },
  avg_ctr: { meaning: 'Long-form impressions CTR (exclude Shorts; <1000 impressions/video = insufficient data).', target: 'Dubler-hybrid 5-7%; entertainment/gaming 6-9%; edu/tutorial 4-6%. Read together with retention.' },
  // D3 (spec 4c81a561 Rész 2): the two formats use DIFFERENT signals and are NEVER
  // mixed. Long-form = thumbnail-CTR; Shorts = in-feed swipe-through ("how many chose
  // to view"), which has no thumbnail-CTR benchmark.
  avg_ctr_long: { meaning: 'Long-form thumbnail impressions CTR, impression-weighted over videos clearing the insufficient-data floor. Shorts are excluded (they carry no thumbnail-CTR in-feed). null = insufficient data.', target: 'Dubler-hybrid 5-7%; entertainment/gaming 6-9%; edu/tutorial 4-6%. Read together with retention.' },
  shorts_swipe_through: { meaning: 'Shorts feed swipe-through ("how many chose to view" from the feed swipe) -- the first-frame hook signal. NOT a thumbnail-CTR; the long-form CTR band never applies. null = swipe-through data absent (insufficient data), never folded into long-form.', target: 'First-frame hook driven; calibrate the swipe-through band per run via date-filtered WebSearch, not a permanent constant.' },
  twitch_followers: { meaning: 'Total Twitch followers.', target: 'Net-positive weekly; Affiliate gate at 25 followers (Twitch lowered the bar 2026-06: 25 followers + 4h streamed + 4 unique broadcast days + 3 avg concurrent, down from 50/8h/7). Verify the live numbers per campaign via a date-filtered Tier-1 search, not a permanent constant.' },
  twitch_avg_concurrents: { meaning: 'Average concurrent viewers while live -- a lagging health signal, not the leading metric (post-Affiliate leaders: Tier-1 sub-count + Discord activity).', target: 'Staged: 3 pre-Affiliate; 5 post-Affiliate with peak/avg<2.5 (organic); 10 at community-scale (~6-12 months). Twitch-only; recalibrate on first multi-platform stream.' },
  // B2: Tier-split sub-count. Post-Affiliate, tier1 is the DA-H4 leading metric.
  twitch_subs_tier1: { meaning: 'Tier-1 subscriber count (Helix data[].tier "1000"). Post-Affiliate this is the leading revenue-health metric, NOT total subs or concurrents.', target: 'Trend-based: net-positive; a Discord sub-perk funnel should accelerate it.' },
  twitch_subs_tier2: { meaning: 'Tier-2 subscriber count (tier "2000").', target: 'Secondary to tier1; watch the mix, not the absolute.' },
  twitch_subs_tier3: { meaning: 'Tier-3 subscriber count (tier "3000").', target: 'Rare on a small channel; each one is a superfan signal.' },
  // B3: peak/avg organic-shape gate.
  twitch_peak_concurrent: { meaning: 'Peak concurrent viewers within the stream. null = a single /streams sample cannot observe a peak (B-layer intraday poll fills it); the organic-check stays insufficient_data while null.', target: 'peak/avg < 2.5 reads as organic sustained viewership; >= 2.5 as a spiky raid/host/bot burst.' },
  // B4: Affiliate stream-hours gate (FRISSITVE 2026-06).
  twitch_stream_hours: { meaning: 'Total live hours in the window (summed archive-VOD durations) -- the Affiliate hours-requirement input.', target: 'Affiliate gate = 4h (240 min) / 30-day rolling (FRISSITVE 2026-06, old 500 min/8.33h). One of four Affiliate axes: 25 followers + 4h + 4 unique broadcast days + 3 avg concurrent.' },
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

  // Net subscriber delta per snapshot (sum of daily gained-lost), windowed.
  const ytDailySubsNet = ytAsc.map(s => sum((s.metrics.subscribers ?? []).map(r => r.net)))
  const subsNet7d = sum(ytDailySubsNet.slice(-7))
  const subsNet30d = sum(ytDailySubsNet)

  // Retention: average of per-snapshot mean audienceWatchRatio (as a %).
  const retentionPerSnap = ytAsc.map(s => avg((s.metrics.retention ?? []).map(r => r.watchRatio)) * 100)
  const avgRetentionPct = avg(retentionPerSnap.slice(-7))

  // CTR: impression-weighted mean across the latest snapshot's ctr rows.
  const latestYt = ytAsc[ytAsc.length - 1]
  const ctrRows = latestYt?.metrics.ctr ?? []
  const totalImp = sum(ctrRows.map(c => c.impressions))
  const avgCtr = totalImp > 0 ? sum(ctrRows.map(c => c.ctr * c.impressions)) / totalImp : 0

  // D3 (spec 4c81a561): keep long-form and Shorts CTR in SEPARATE buckets and expose
  // them as two distinct KPIs (avg_ctr_long vs shorts_swipe_through), never mixed.
  // Untagged rows are long-form (backward-compatible with pre-D3 snapshots); a Shorts
  // row without swipe-through data => insufficient_data, never in the long-form bucket.
  const ctrByFormat = aggregateCtrByFormat(
    ctrRows as FormatTaggedCtrRow[],
    DEFAULT_IMPRESSION_FLOOR, // injectable floor; calibrate per run, not a baked constant.
  )

  // Twitch KPIs.
  const twFollowers = twAsc.map(s => s.metrics.followers?.total ?? 0)
  const twitchFollowers = twFollowers[twFollowers.length - 1] ?? 0
  const twConcurrents = twAsc
    .map(s => s.metrics.stream?.viewerCount)
    .filter((v): v is number => typeof v === 'number')
  const twitchAvgConcurrents = avg(twConcurrents)

  // Latest Twitch snapshot for the point-in-time B2/B3/B4 metrics.
  const latestTwMetrics = twAsc[twAsc.length - 1]?.metrics
  // B2: Tier-split sub-count (guarded -- pre-B2 snapshots lack the tier fields).
  const twSubsTier1 = latestTwMetrics?.subscriptions?.tier1 ?? 0
  const twSubsTier2 = latestTwMetrics?.subscriptions?.tier2 ?? 0
  const twSubsTier3 = latestTwMetrics?.subscriptions?.tier3 ?? 0
  // B3: peak concurrent + organic-shape gate (null while no intraday sample).
  const twPeakConcurrent = latestTwMetrics?.stream?.peakConcurrent ?? null
  const twPeakAvgLabel = peakAvgConcurrentLabel(twPeakConcurrent, twitchAvgConcurrents)
  // B4: stream-hours window + Affiliate hours-gate (240 min / 4h, FRISSITVE 2026-06).
  const twStreamMinutes = latestTwMetrics?.streamMinutesWindow ?? 0
  const twAffiliateHoursLabel = affiliateHoursLabel(twStreamMinutes)

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
  // B5: rank top_videos by retained-views (views x retention), NOT the impression
  // proxy. Falls back to impressions when a snapshot has no per-video views/retention
  // (pre-B5), so old data still orders sanely. Surface views + avgViewPercentage so
  // the dashboard can show WHY a video ranks where it does.
  const topVideos = (latestYt?.metrics.ctr ?? [])
    .slice()
    .sort((a, b) => retainedViewsScore(b) - retainedViewsScore(a))
    .slice(0, 5)
    .map(v => ({
      videoId: v.videoId,
      impressions: v.impressions,
      ctr: v.ctr,
      views: v.views ?? null,
      avgViewPercentage: v.avgViewPercentage ?? null,
      retainedViewsScore: Number(retainedViewsScore(v).toFixed(2)),
    }))

  // B5: traffic-source surface. The CTR-floor assumption depends on WHERE the CTR
  // comes from (suggested-heavy vs search-heavy read very differently), so expose the
  // per-bucket views/minutes from the latest snapshot. Aggregated by the 4+other
  // buckets the parser already maps (browse/suggested/search/external/other).
  const trafficBuckets: Record<string, { views: number; minutesWatched: number }> = {}
  for (const t of (latestYt?.metrics.traffic ?? []) as YtTrafficBucket[]) {
    const b = (trafficBuckets[t.bucket] ??= { views: 0, minutesWatched: 0 })
    b.views += t.views
    b.minutesWatched += t.minutesWatched
  }
  const trafficViewsTotal = Object.values(trafficBuckets).reduce((a, b) => a + b.views, 0)
  const trafficSources = Object.entries(trafficBuckets)
    .map(([bucket, v]) => ({
      bucket,
      views: v.views,
      minutesWatched: v.minutesWatched,
      viewsShare: trafficViewsTotal > 0 ? Number((v.views / trafficViewsTotal).toFixed(4)) : 0,
    }))
    .sort((a, b) => b.views - a.views)

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
      subs_net_7d: subsNet7d,
      subs_net_30d: subsNet30d,
      views_7d: views7d,
      views_30d: views30d,
      avg_retention_pct: Number(avgRetentionPct.toFixed(2)),
      avg_ctr: Number(avgCtr.toFixed(4)),
      // D3: two distinct, never-mixed KPIs. null surfaces as insufficient_data.
      avg_ctr_long: ctrByFormat.avgCtrLong === null ? null : Number(ctrByFormat.avgCtrLong.toFixed(4)),
      shorts_swipe_through: ctrByFormat.shortsSwipeThrough === null ? null : Number(ctrByFormat.shortsSwipeThrough.toFixed(4)),
      twitch_followers: twitchFollowers,
      twitch_avg_concurrents: Number(twitchAvgConcurrents.toFixed(1)),
      // B2: Tier-split sub-count (post-Affiliate leading metric = tier1).
      twitch_subs_tier1: twSubsTier1,
      twitch_subs_tier2: twSubsTier2,
      twitch_subs_tier3: twSubsTier3,
      // B3: peak concurrent (null => insufficient_data on the organic-shape gate).
      twitch_peak_concurrent: twPeakConcurrent,
      // B4: stream-hours window (Affiliate hours-gate input).
      twitch_stream_hours: Number((twStreamMinutes / 60).toFixed(2)),
    },
    // B3/B4: data-gate verdicts (green/red/grey) for the metrics that carry a gate.
    // insufficient_data (grey) means "not enough signal to colour", never a silent 0.
    gates: {
      // peak/avg organic-shape check -- insufficient_data while peakConcurrent is null.
      twitch_peak_avg: twPeakAvgLabel,
      // Affiliate stream-hours axis: ok at/above 240 min (4h) / 30 days, else flag.
      twitch_affiliate_hours: twAffiliateHoursLabel,
    },
    annotations: KPI_ANNOTATIONS,
    trend,
    tables: {
      top_videos: topVideos,
      // B5: traffic-source mix (browse/suggested/search/external/other) for the
      // CTR-floor assumption-map.
      traffic_sources: trafficSources,
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
