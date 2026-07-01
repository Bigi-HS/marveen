// Token pointer loader for analytics OAuth (card 6498275e).
// Returns a FILE PATH (pointer) or null -- NEVER the raw token value.
// Token content must not be logged; redaction test enforces this.

/**
 * Returns the path to the Google analytics token file (from GOOGLE_ANALYTICS_TOKEN_FILE),
 * or null if not configured (not-yet-consented state).
 */
export function loadGoogleTokenPath(): string | null {
  const v = process.env['GOOGLE_ANALYTICS_TOKEN_FILE']?.trim()
  return v || null
}

/**
 * Returns the path to the Twitch analytics token file (from TWITCH_ANALYTICS_TOKEN_FILE),
 * or null if not configured (not-yet-consented state).
 */
export function loadTwitchTokenPath(): string | null {
  const v = process.env['TWITCH_ANALYTICS_TOKEN_FILE']?.trim()
  return v || null
}
