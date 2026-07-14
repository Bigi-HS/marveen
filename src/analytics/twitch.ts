// Twitch Helix API client (card 6498275e).
// Pure request-builder + pure response-parser split -- no live token needed for tests.
// NOTE: Twitch has NO per-video retention curves or thumbnail CTR via the API.
// Exposes ONLY what the Helix API actually returns: followers, subs, concurrents, VOD views.

// ── Types ────────────────────────────────────────────────────────────────────

export interface HelixRequest {
  endpoint: string
  params: Record<string, string | number>
}

export interface TwitchFollowersSummary {
  total: number
}

export interface TwitchSubsSummary {
  total: number
  points: number
  // B2 (spec 4c81a561): Tier-split sub-count from Helix data[].tier enum
  // '1000'|'2000'|'3000'. Post-Affiliate, tier1 is the DA-H4 leading metric
  // (NOT total, NOT concurrents). Counts are over the RETURNED page of data[]:
  // Helix paginates at 100, so for a small channel (all subs on one page) the
  // counts are exact; a >100-sub base would need cursor-following in the B-layer.
  tier1: number // tier === '1000'
  tier2: number // tier === '2000'
  tier3: number // tier === '3000'
}

export interface TwitchStreamSummary {
  isLive: boolean
  viewerCount: number | null
  title: string | null
  startedAt: string | null
  // B3 (spec 4c81a561): peak concurrent viewers within the stream. Helix /streams
  // returns only the CURRENT viewer_count (a single intraday sample), so a single
  // pull cannot observe the peak -> null. The B-layer fills this from either an
  // intraday poll (max-hold) or a stream-summary source. While null the data-gate
  // must return insufficient_data for the peak/avg organic-check (never false-green
  // a peak/avg ratio from one sample).
  peakConcurrent: number | null
}

export interface TwitchVodSummary {
  id: string
  title: string
  viewCount: number
  createdAt: string
  duration: string
}

// ── Request builders ──────────────────────────────────────────────────────────

export function buildFollowersRequest(opts: { broadcasterId: string }): HelixRequest {
  return {
    endpoint: '/helix/channels/followers',
    params: { broadcaster_id: opts.broadcasterId },
  }
}

export function buildSubscriptionsRequest(opts: { broadcasterId: string }): HelixRequest {
  return {
    endpoint: '/helix/subscriptions',
    params: { broadcaster_id: opts.broadcasterId },
  }
}

export function buildStreamRequest(opts: { userLogin: string }): HelixRequest {
  return {
    endpoint: '/helix/streams',
    params: { user_login: opts.userLogin },
  }
}

export function buildVideosRequest(opts: { userId: string; first?: number }): HelixRequest {
  return {
    endpoint: '/helix/videos',
    params: { user_id: opts.userId, first: opts.first ?? 20 },
  }
}

// ── Response parsers ──────────────────────────────────────────────────────────

export function parseFollowersResponse(raw: unknown): TwitchFollowersSummary {
  const r = raw as { total?: number }
  return { total: r.total ?? 0 }
}

// Twitch subscriber-point weights per tier (platform constants, not a calibration
// number): Tier 1 = 1, Tier 2 = 2, Tier 3 = 6. Source: Twitch Help "Subscriptions"
// (sub-points / leaderboard weighting). Used only as a FALLBACK when Helix does not
// return `points` directly.
const TIER_POINTS: Record<'1000' | '2000' | '3000', number> = { '1000': 1, '2000': 2, '3000': 6 }

export function parseSubscriptionsResponse(raw: unknown): TwitchSubsSummary {
  const r = raw as { total?: number; points?: number; data?: Array<{ tier?: string }> }
  const data = r.data ?? []
  let tier1 = 0, tier2 = 0, tier3 = 0
  for (const s of data) {
    if (s.tier === '1000') tier1++
    else if (s.tier === '2000') tier2++
    else if (s.tier === '3000') tier3++
  }
  // Prefer the API-provided points; fall back to the tier-weighted sum if absent.
  const points = r.points ?? (tier1 * TIER_POINTS['1000'] + tier2 * TIER_POINTS['2000'] + tier3 * TIER_POINTS['3000'])
  return {
    total: r.total ?? 0,
    points,
    tier1,
    tier2,
    tier3,
  }
}

export function parseStreamResponse(raw: unknown): TwitchStreamSummary {
  const r = raw as { data?: Array<{ viewer_count?: number; title?: string; started_at?: string; type?: string }> }
  const stream = r.data?.[0]
  if (!stream || stream.type !== 'live') {
    return { isLive: false, viewerCount: null, title: null, startedAt: null, peakConcurrent: null }
  }
  return {
    isLive: true,
    viewerCount: stream.viewer_count ?? null,
    title: stream.title ?? null,
    startedAt: stream.started_at ?? null,
    // B3: a single /streams sample carries no peak; the B-layer fills this.
    peakConcurrent: null,
  }
}

export function parseVideosResponse(raw: unknown): TwitchVodSummary[] {
  const r = raw as { data?: Array<{ id?: string; title?: string; view_count?: number; created_at?: string; duration?: string }> }
  return (r.data ?? []).map(v => ({
    id: v.id ?? '',
    title: v.title ?? '',
    viewCount: v.view_count ?? 0,
    createdAt: v.created_at ?? '',
    duration: v.duration ?? '',
  }))
}

// ── B4: stream-hours (Affiliate-gate input) ─────────────────────────────────────

// Parse the Twitch VOD duration string ("2h30m15s" / "1h15m00s" / "45m30s" / "30s")
// into minutes. Twitch renders durations in this h/m/s shorthand; any missing unit
// is simply absent. Returns 0 for an empty/unparseable string (never NaN).
export function parseTwitchDurationMinutes(duration: string): number {
  if (!duration) return 0
  const h = /(\d+)h/.exec(duration)
  const m = /(\d+)m/.exec(duration)
  const s = /(\d+)s/.exec(duration)
  const hours = h ? Number(h[1]) : 0
  const mins = m ? Number(m[1]) : 0
  const secs = s ? Number(s[1]) : 0
  return hours * 60 + mins + secs / 60
}

/**
 * B4 -- total live minutes in the window, summed over archive VODs. This is the
 * Affiliate-gate input (spec: gate = 240 min / 4h over a rolling 30-day window;
 * FRISSITVE 2026-06 -- old bar was 500 min / 8.33h). VOD duration is the best
 * proxy the Helix API gives for streamed time; the B-layer may swap in a
 * stream-session log if one is kept. `type === 'archive'` filters out clips/uploads.
 */
export function sumStreamMinutes(vods: TwitchVodSummary[]): number {
  return vods.reduce((a, v) => a + parseTwitchDurationMinutes(v.duration), 0)
}
