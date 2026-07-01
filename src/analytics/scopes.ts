// Single source of truth for analytics OAuth scopes (card 6498275e).
// Assertion tests enforce read-only minimalism -- no write/monetary scope may be added here.

/** Required Google scopes for YouTube analytics. Exactly 2, both readonly. */
export const GOOGLE_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
] as const

/** Required Twitch scopes (user-token; needed for subs/followers). Exactly 2, both :read:. */
export const TWITCH_SCOPES: readonly string[] = [
  'channel:read:subscriptions',
  'moderator:read:followers',
] as const

/** Optional Twitch scopes, gated behind a separate sub-flag. NOT included in the default consent. */
export const TWITCH_OPTIONAL_SCOPES: readonly string[] = [
  'analytics:read:games',
] as const
