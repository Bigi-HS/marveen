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
}

export interface TwitchStreamSummary {
  isLive: boolean
  viewerCount: number | null
  title: string | null
  startedAt: string | null
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

export function parseSubscriptionsResponse(raw: unknown): TwitchSubsSummary {
  const r = raw as { total?: number; points?: number }
  return {
    total: r.total ?? 0,
    points: r.points ?? 0,
  }
}

export function parseStreamResponse(raw: unknown): TwitchStreamSummary {
  const r = raw as { data?: Array<{ viewer_count?: number; title?: string; started_at?: string; type?: string }> }
  const stream = r.data?.[0]
  if (!stream || stream.type !== 'live') {
    return { isLive: false, viewerCount: null, title: null, startedAt: null }
  }
  return {
    isLive: true,
    viewerCount: stream.viewer_count ?? null,
    title: stream.title ?? null,
    startedAt: stream.started_at ?? null,
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
