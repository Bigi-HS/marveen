/**
 * B-layer contract + label-logic tests (card 4c81a561, B2-B4/B5).
 * Covers the OAuth-independent slice: contract fields, pure parsers, gate labels,
 * and the dashboard surface. Everything runs against fixtures / inline data + an
 * in-memory DB -- NO live token, NO network, NO OAuth.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  parseSubscriptionsResponse,
  parseStreamResponse,
  parseTwitchDurationMinutes,
  sumStreamMinutes,
  type TwitchVodSummary,
} from '../analytics/twitch.js'
import { parseCtrResponse } from '../analytics/youtube.js'
import {
  peakAvgConcurrentLabel,
  affiliateHoursLabel,
  retainedViewsScore,
  DEFAULT_AFFILIATE_HOURS_THRESHOLDS,
} from '../analytics/labels.js'
import {
  applyAnalyticsMigrations,
  upsertSnapshot,
  type AnalyticsSnapshotRow,
} from '../analytics/storage.js'
import { buildAnalyticsDashboard } from '../web/routes/analytics.js'

// ── B2: Tier-split sub-count ─────────────────────────────────────────────────────

describe('B2 -- parseSubscriptionsResponse tier split', () => {
  it('counts tier1/2/3 from data[].tier and prefers the API points', () => {
    const parsed = parseSubscriptionsResponse({
      total: 4,
      points: 99,
      data: [{ tier: '1000' }, { tier: '1000' }, { tier: '2000' }, { tier: '3000' }],
    })
    expect(parsed.tier1).toBe(2)
    expect(parsed.tier2).toBe(1)
    expect(parsed.tier3).toBe(1)
    expect(parsed.points).toBe(99) // API points preferred over the weighted fallback
    expect(parsed.total).toBe(4)
  })

  it('falls back to the tier-weighted points sum when the API omits points', () => {
    const parsed = parseSubscriptionsResponse({
      total: 4,
      data: [{ tier: '1000' }, { tier: '1000' }, { tier: '2000' }, { tier: '3000' }],
    })
    // 2*1 + 1*2 + 1*6 = 10
    expect(parsed.points).toBe(10)
  })

  it('defaults tiers to zero for an empty/absent data page', () => {
    const parsed = parseSubscriptionsResponse({ total: 0 })
    expect(parsed.tier1).toBe(0)
    expect(parsed.tier2).toBe(0)
    expect(parsed.tier3).toBe(0)
    expect(parsed.points).toBe(0)
  })
})

// ── B3: peak concurrent + organic-shape gate ─────────────────────────────────────

describe('B3 -- peakConcurrent parse + peak/avg gate', () => {
  it('a single live sample yields peakConcurrent null (no peak observable)', () => {
    const s = parseStreamResponse({ data: [{ type: 'live', viewer_count: 247 }] })
    expect(s.isLive).toBe(true)
    expect(s.viewerCount).toBe(247)
    expect(s.peakConcurrent).toBeNull()
  })

  it('gate is insufficient_data while peak is null (never false-green from one sample)', () => {
    expect(peakAvgConcurrentLabel(null, 100)).toBe('insufficient_data')
  })

  it('peak/avg below 2.5 is organic ok, at/above is a spiky flag', () => {
    expect(peakAvgConcurrentLabel(200, 100)).toBe('ok')   // ratio 2.0 < 2.5
    expect(peakAvgConcurrentLabel(300, 100)).toBe('flag') // ratio 3.0 >= 2.5
  })

  it('gate is insufficient_data when avg is zero (no viewers to ratio against)', () => {
    expect(peakAvgConcurrentLabel(50, 0)).toBe('insufficient_data')
  })
})

// ── B4: stream-hours + Affiliate gate (240 min / 4h, FRISSITVE 2026-06) ──────────

describe('B4 -- stream-hours parse + Affiliate gate', () => {
  it('parses the Twitch duration shorthand into minutes', () => {
    expect(parseTwitchDurationMinutes('2h30m15s')).toBeCloseTo(150.25, 2)
    expect(parseTwitchDurationMinutes('1h15m00s')).toBeCloseTo(75, 2)
    expect(parseTwitchDurationMinutes('45m30s')).toBeCloseTo(45.5, 2)
    expect(parseTwitchDurationMinutes('30s')).toBeCloseTo(0.5, 2)
    expect(parseTwitchDurationMinutes('')).toBe(0)
  })

  it('sums archive VOD durations into a window minute total', () => {
    const vods: TwitchVodSummary[] = [
      { id: 'a', title: '', viewCount: 0, createdAt: '', duration: '3h00m00s', videoType: 'archive' },
      { id: 'b', title: '', viewCount: 0, createdAt: '', duration: '3h00m00s', videoType: 'archive' },
    ]
    expect(sumStreamMinutes(vods)).toBeCloseTo(360, 2)
  })

  it('EXCLUDES highlights/uploads from stream-hours (no Affiliate false-green)', () => {
    const vods: TwitchVodSummary[] = [
      { id: 'a', title: '', viewCount: 0, createdAt: '', duration: '2h00m00s', videoType: 'archive' },
      { id: 'hl', title: '', viewCount: 0, createdAt: '', duration: '5h00m00s', videoType: 'highlight' },
      { id: 'up', title: '', viewCount: 0, createdAt: '', duration: '9h00m00s', videoType: 'upload' },
      { id: 'unk', title: '', viewCount: 0, createdAt: '', duration: '9h00m00s', videoType: '' },
    ]
    // Only the 2h archive counts; the 5h highlight + 9h upload + unknown-type do NOT.
    // Without the filter the sum would be 25h and false-green the 4h Affiliate gate.
    expect(sumStreamMinutes(vods)).toBeCloseTo(120, 2)
    expect(affiliateHoursLabel(sumStreamMinutes(vods))).toBe('flag')
  })

  it('gate default is 240 minutes (FRISSITVE 2026-06, not the old 500)', () => {
    expect(DEFAULT_AFFILIATE_HOURS_THRESHOLDS.gateMinutes).toBe(240)
  })

  it('360 min clears the gate (ok), 180 min does not (flag)', () => {
    expect(affiliateHoursLabel(360)).toBe('ok')  // 6h over the 4h gate
    expect(affiliateHoursLabel(180)).toBe('flag') // 3h under the 4h gate
    expect(affiliateHoursLabel(240)).toBe('ok')  // exactly at the gate
  })

  it('negative/NaN minutes are insufficient_data, never falsely coloured', () => {
    expect(affiliateHoursLabel(-1)).toBe('insufficient_data')
    expect(affiliateHoursLabel(Number.NaN)).toBe('insufficient_data')
  })
})

// ── B5: per-video contract + retained-views ranking ──────────────────────────────

describe('B5 -- CTR optional columns + retained-views score', () => {
  it('parses views + averageViewPercentage when the columns are present', () => {
    const rows = parseCtrResponse({
      columnHeaders: [
        { name: 'video' }, { name: 'impressions' }, { name: 'impressionsClickThroughRate' },
        { name: 'views' }, { name: 'averageViewPercentage' },
      ],
      rows: [['v1', 10000, 0.05, 8000, 55]],
    })
    expect(rows[0].views).toBe(8000)
    expect(rows[0].avgViewPercentage).toBe(55)
  })

  it('leaves the optional fields undefined when the columns are absent (backward compat)', () => {
    const rows = parseCtrResponse({
      columnHeaders: [{ name: 'video' }, { name: 'impressions' }, { name: 'impressionsClickThroughRate' }],
      rows: [['v1', 10000, 0.05]],
    })
    expect(rows[0].views).toBeUndefined()
    expect(rows[0].avgViewPercentage).toBeUndefined()
  })

  it('scores by views x retention, falling back to impressions when views absent', () => {
    expect(retainedViewsScore({ impressions: 100, views: 1000, avgViewPercentage: 50 })).toBe(500)
    expect(retainedViewsScore({ impressions: 100, views: 1000 })).toBe(1000) // no retention => weight 1
    expect(retainedViewsScore({ impressions: 100 })).toBe(100) // no views => impression fallback
  })
})

// ── Dashboard surface: B2-B4/B5 KPIs, gates and tables ───────────────────────────

function okYtWithVideos(date: string): AnalyticsSnapshotRow {
  return {
    source: 'youtube',
    period_date: date,
    status: 'ok',
    pulled_at: 1_782_000_000,
    period_from: date,
    period_to: date,
    metrics_json: JSON.stringify({
      watchtime: [{ day: date, minutesWatched: 100, avgViewDuration: 400, views: 500 }],
      // impressions order: ghi > abc > def; retained-views order: def > abc > ghi.
      ctr: [
        { videoId: 'abc', impressions: 12000, ctr: 0.05, views: 9000, avgViewPercentage: 60 },
        { videoId: 'def', impressions: 8500, ctr: 0.04, views: 7000, avgViewPercentage: 80 },
        { videoId: 'ghi', impressions: 21000, ctr: 0.06, views: 12000, avgViewPercentage: 35 },
      ],
      retention: [{ elapsedRatio: 0, watchRatio: 0.5, relativePerformance: 1 }],
      traffic: [
        { sourceType: 'YT_SEARCH', bucket: 'search', views: 3000, minutesWatched: 14000 },
        { sourceType: 'SUBSCRIBER', bucket: 'browse', views: 4000, minutesWatched: 18000 },
        { sourceType: 'RELATED_VIDEO', bucket: 'suggested', views: 2000, minutesWatched: 9000 },
        { sourceType: 'YT_CHANNEL', bucket: 'browse', views: 1000, minutesWatched: 4000 },
      ],
      subscribers: [{ day: date, gained: 20, lost: 5, net: 15 }],
    }),
    reason: null,
    detail: null,
  }
}

function okTwFull(date: string): AnalyticsSnapshotRow {
  return {
    source: 'twitch',
    period_date: date,
    status: 'ok',
    pulled_at: 1_782_000_000,
    period_from: date,
    period_to: date,
    metrics_json: JSON.stringify({
      followers: { total: 30 },
      subscriptions: { total: 9, points: 10, tier1: 8, tier2: 1, tier3: 0 },
      stream: { isLive: true, viewerCount: 100, title: 'S', startedAt: date, peakConcurrent: 180 },
      videos: [],
      streamMinutesWindow: 360,
    }),
    reason: null,
    detail: null,
  }
}

describe('buildAnalyticsDashboard -- B2-B4/B5 surface', () => {
  let db: ReturnType<typeof Database>
  beforeEach(() => {
    db = new Database(':memory:')
    applyAnalyticsMigrations(db)
  })

  it('surfaces tier split, peak-concurrent gate, stream-hours gate and retained-views ranking', () => {
    upsertSnapshot(okYtWithVideos('2026-06-28'), db)
    upsertSnapshot(okTwFull('2026-06-28'), db)
    const p = buildAnalyticsDashboard(db) as any

    // B2: Tier-split sub-count.
    expect(p.kpi.twitch_subs_tier1).toBe(8)
    expect(p.kpi.twitch_subs_tier2).toBe(1)
    expect(p.kpi.twitch_subs_tier3).toBe(0)

    // B3: peak concurrent + gate. peak 180 / avg 100 = 1.8 < 2.5 -> organic ok.
    expect(p.kpi.twitch_peak_concurrent).toBe(180)
    expect(p.gates.twitch_peak_avg).toBe('ok')

    // B4: stream-hours + Affiliate gate. 360 min = 6h over the 240 min gate -> ok.
    expect(p.kpi.twitch_stream_hours).toBeCloseTo(6, 2)
    expect(p.gates.twitch_affiliate_hours).toBe('ok')

    // B5: top_videos ranked by retained-views (def first, ghi last), with the fields.
    expect(p.tables.top_videos[0].videoId).toBe('def')
    expect(p.tables.top_videos[2].videoId).toBe('ghi')
    expect(p.tables.top_videos[0].views).toBe(7000)
    expect(p.tables.top_videos[0].avgViewPercentage).toBe(80)

    // B5: traffic-source surface with per-bucket views + share, browse merged.
    const search = p.tables.traffic_sources.find((t: any) => t.bucket === 'search')
    const browse = p.tables.traffic_sources.find((t: any) => t.bucket === 'browse')
    expect(browse.views).toBe(5000) // SUBSCRIBER 4000 + YT_CHANNEL 1000 merged
    expect(search.views).toBe(3000)
    expect(browse.viewsShare).toBeCloseTo(0.5, 2) // 5000 / 10000 total
  })

  it('degrades gracefully on pre-B-layer snapshots (missing tier/peak/hours fields)', () => {
    // An old-shape snapshot with none of the B2-B4 fields must not throw.
    upsertSnapshot({
      source: 'twitch',
      period_date: '2026-06-28',
      status: 'ok',
      pulled_at: 1_782_000_000,
      period_from: '2026-06-28',
      period_to: '2026-06-28',
      metrics_json: JSON.stringify({
        followers: { total: 10 },
        subscriptions: { total: 5, points: 5 },
        stream: { isLive: false, viewerCount: null, title: null, startedAt: null },
        videos: [],
      }),
      reason: null,
      detail: null,
    }, db)
    const p = buildAnalyticsDashboard(db) as any
    expect(p.kpi.twitch_subs_tier1).toBe(0)
    expect(p.kpi.twitch_peak_concurrent).toBeNull()
    expect(p.gates.twitch_peak_avg).toBe('insufficient_data')
    expect(p.kpi.twitch_stream_hours).toBe(0)
    expect(p.gates.twitch_affiliate_hours).toBe('flag') // 0 min < 240 gate
  })
})
