// YouTube Analytics API client (card 6498275e).
// Pure request-builder + pure response-parser split -- no live token needed for tests.

// ── Types ────────────────────────────────────────────────────────────────────

export interface YtAnalyticsRequest {
  ids: string
  startDate: string
  endDate: string
  metrics: string
  dimensions: string
  filters?: string
}

export interface YtCtrRow {
  videoId: string
  impressions: number
  ctr: number
  // B5 (spec 4c81a561): per-video views + retention proxy, so top_videos can rank
  // by retained-views (views x avgViewPercentage) instead of the impression proxy.
  // OPTIONAL for backward compat: pre-B5 snapshots (and any response that does not
  // include the columns) leave these undefined and the ranking falls back to
  // impressions. `averageViewPercentage` is the % of the video watched (0-100).
  views?: number
  avgViewPercentage?: number
}

export interface YtRetentionRow {
  elapsedRatio: number
  watchRatio: number
  relativePerformance: number | null
}

export type TrafficBucket = 'browse' | 'suggested' | 'search' | 'external' | 'other'

export interface YtTrafficBucket {
  sourceType: string
  bucket: TrafficBucket
  views: number
  minutesWatched: number
}

export interface YtWatchtimeRow {
  day: string
  minutesWatched: number
  avgViewDuration: number
  views: number
}

export interface YtSubscribersRow {
  day: string
  gained: number
  lost: number
  net: number // gained - lost (net daily subscriber delta)
}

// ── Traffic source bucket map ─────────────────────────────────────────────────
// Maps the insightTrafficSourceType enum values the Analytics API returns to the
// 4 buckets the youtube-full audit method uses (browse/suggested/search/external).
// Source: developers.google.com/youtube/analytics/dimensions (official API enum).
// NOTE: BROWSE_FEATURES and SUGGESTED_VIDEOS are YouTube Studio UI labels only --
// the API never returns them; removed to avoid false-green fixture tests.
const TRAFFIC_BUCKET_MAP: Record<string, TrafficBucket> = {
  SUBSCRIBER:        'browse',    // homepage/subscriptions feed
  YT_CHANNEL:        'browse',    // channel page (intentional: browse family)
  RELATED_VIDEO:     'suggested', // suggested videos panel
  END_SCREEN:        'suggested', // end screen cards (intentional: suggested family)
  YT_SEARCH:         'search',
  EXT_URL:           'external',
  SHORTS:            'other',
  PLAYLIST:          'other',
  NOTIFICATION:      'other',
  NO_LINK_OTHER:     'other',
  NO_LINK_EMBEDDED:  'other',
}

// ── Request builders ──────────────────────────────────────────────────────────

export function buildCtrRequest(opts: {
  channelId: string; startDate: string; endDate: string
}): YtAnalyticsRequest {
  return {
    ids: `channel==${opts.channelId}`,
    startDate: opts.startDate,
    endDate: opts.endDate,
    // B5: also pull per-video views + averageViewPercentage so top_videos can rank
    // by retained-views. All four are valid metrics with dimension=video (source:
    // developers.google.com/youtube/analytics/metrics).
    metrics: 'impressions,impressionsClickThroughRate,views,averageViewPercentage',
    dimensions: 'video',
  }
}

export function buildRetentionRequest(opts: {
  channelId: string; videoId: string; startDate: string; endDate: string
}): YtAnalyticsRequest {
  return {
    ids: `channel==${opts.channelId}`,
    startDate: opts.startDate,
    endDate: opts.endDate,
    metrics: 'audienceWatchRatio,relativeRetentionPerformance',
    dimensions: 'elapsedVideoTimeRatio',
    filters: `video==${opts.videoId}`,
  }
}

export function buildTrafficRequest(opts: {
  channelId: string; startDate: string; endDate: string
}): YtAnalyticsRequest {
  return {
    ids: `channel==${opts.channelId}`,
    startDate: opts.startDate,
    endDate: opts.endDate,
    metrics: 'views,estimatedMinutesWatched',
    dimensions: 'insightTrafficSourceType',
  }
}

export function buildWatchtimeRequest(opts: {
  channelId: string; startDate: string; endDate: string
}): YtAnalyticsRequest {
  return {
    ids: `channel==${opts.channelId}`,
    startDate: opts.startDate,
    endDate: opts.endDate,
    metrics: 'estimatedMinutesWatched,averageViewDuration,views',
    dimensions: 'day',
  }
}

// Daily subscriber deltas (spec 2: subscribersGained/subscribersLost/net).
// Official metrics: developers.google.com/youtube/analytics/metrics.
export function buildSubscribersRequest(opts: {
  channelId: string; startDate: string; endDate: string
}): YtAnalyticsRequest {
  return {
    ids: `channel==${opts.channelId}`,
    startDate: opts.startDate,
    endDate: opts.endDate,
    metrics: 'subscribersGained,subscribersLost',
    dimensions: 'day',
  }
}

// ── Response parsers ──────────────────────────────────────────────────────────

interface RawAnalyticsResponse {
  columnHeaders?: Array<{ name: string; dataType: string }>
  rows?: unknown[] | null
}

function colIndex(headers: Array<{ name: string }>, name: string): number {
  const i = headers.findIndex(h => h.name === name)
  if (i === -1) throw new Error(`Analytics API response missing expected column "${name}"`)
  return i
}

// Non-throwing column lookup for OPTIONAL columns (B5): returns -1 when absent so
// the parser can degrade gracefully instead of throwing on a response that lacks
// the newer per-video metrics.
function colIndexOpt(headers: Array<{ name: string }>, name: string): number {
  return headers.findIndex(h => h.name === name)
}

export function parseCtrResponse(raw: unknown): YtCtrRow[] {
  const r = raw as RawAnalyticsResponse
  if (!r.rows?.length || !r.columnHeaders) return []
  const h = r.columnHeaders
  const iVideo = colIndex(h, 'video')
  const iImp = colIndex(h, 'impressions')
  const iCtr = colIndex(h, 'impressionsClickThroughRate')
  // B5 optional per-video metrics -- only mapped when the columns are present.
  const iViews = colIndexOpt(h, 'views')
  const iAvgPct = colIndexOpt(h, 'averageViewPercentage')
  return (r.rows as unknown[][]).map(row => {
    const out: YtCtrRow = {
      videoId: row[iVideo] as string,
      impressions: row[iImp] as number,
      ctr: row[iCtr] as number,
    }
    if (iViews !== -1) out.views = row[iViews] as number
    if (iAvgPct !== -1) out.avgViewPercentage = row[iAvgPct] as number
    return out
  })
}

export function parseRetentionResponse(raw: unknown): YtRetentionRow[] {
  const r = raw as RawAnalyticsResponse
  if (!r.rows?.length || !r.columnHeaders) return []
  const h = r.columnHeaders
  const iElapsed = colIndex(h, 'elapsedVideoTimeRatio')
  const iWatch = colIndex(h, 'audienceWatchRatio')
  const iRel = colIndex(h, 'relativeRetentionPerformance')
  return (r.rows as unknown[][]).map(row => ({
    elapsedRatio: row[iElapsed] as number,
    watchRatio: row[iWatch] as number,
    relativePerformance: (row[iRel] ?? null) as number | null,
  }))
}

export function parseTrafficResponse(raw: unknown): YtTrafficBucket[] {
  const r = raw as RawAnalyticsResponse
  if (!r.rows?.length || !r.columnHeaders) return []
  const h = r.columnHeaders
  const iType = colIndex(h, 'insightTrafficSourceType')
  const iViews = colIndex(h, 'views')
  const iMin = colIndex(h, 'estimatedMinutesWatched')
  return (r.rows as unknown[][]).map(row => {
    const sourceType = row[iType] as string
    return {
      sourceType,
      bucket: TRAFFIC_BUCKET_MAP[sourceType] ?? 'other',
      views: row[iViews] as number,
      minutesWatched: row[iMin] as number,
    }
  })
}

export function parseWatchtimeResponse(raw: unknown): YtWatchtimeRow[] {
  const r = raw as RawAnalyticsResponse
  if (!r.rows?.length || !r.columnHeaders) return []
  const h = r.columnHeaders
  const iDay = colIndex(h, 'day')
  const iMin = colIndex(h, 'estimatedMinutesWatched')
  const iAvg = colIndex(h, 'averageViewDuration')
  const iViews = colIndex(h, 'views')
  return (r.rows as unknown[][]).map(row => ({
    day: row[iDay] as string,
    minutesWatched: row[iMin] as number,
    avgViewDuration: row[iAvg] as number,
    views: row[iViews] as number,
  }))
}

export function parseSubscribersResponse(raw: unknown): YtSubscribersRow[] {
  const r = raw as RawAnalyticsResponse
  if (!r.rows?.length || !r.columnHeaders) return []
  const h = r.columnHeaders
  const iDay = colIndex(h, 'day')
  const iGained = colIndex(h, 'subscribersGained')
  const iLost = colIndex(h, 'subscribersLost')
  return (r.rows as unknown[][]).map(row => {
    const gained = row[iGained] as number
    const lost = row[iLost] as number
    return { day: row[iDay] as string, gained, lost, net: gained - lost }
  })
}
