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

/**
 * Optional Twitch scopes -- gated behind TWITCH_ANALYTICS_GAMES_ENABLED (default OFF, separate from
 * the main ANALYTICS_OAUTH_ENABLED flag). NOT included in the default Boss consent screen.
 * Only add to the consent flow if Boss explicitly requests game-level analytics CSV reports.
 */
export const TWITCH_OPTIONAL_SCOPES: readonly string[] = [
  'analytics:read:games',
] as const
