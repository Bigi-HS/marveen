// Analytics OAuth orchestrator (card 6498275e).
// Feature flag ANALYTICS_OAUTH_ENABLED -- default OFF.
// Flag off OR token null -> returns {status:'disabled'|'not-consented', data:null}, NEVER throws.
// status:'ok' with live data is wired in the follow-up card after Boss OAuth consent (out of this scaffold).

import { loadGoogleTokenPath, loadTwitchTokenPath } from './tokens.js'

export type AnalyticsStatus = 'disabled' | 'not-consented' | 'ok' | 'error'

export interface AnalyticsResult {
  status: AnalyticsStatus
  data: null | {
    youtube?: unknown
    twitch?: unknown
  }
}

function isFlagEnabled(): boolean {
  const v = (process.env['ANALYTICS_OAUTH_ENABLED'] ?? '').toLowerCase().trim()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

/**
 * Pull analytics from YouTube and Twitch.
 * Returns {status:'disabled'} when the feature flag is OFF.
 * Returns {status:'not-consented'} when tokens are not yet configured.
 * Never throws -- all errors surface as {status:'error', data:null}.
 */
export async function pull(): Promise<AnalyticsResult> {
  try {
    if (!isFlagEnabled()) {
      return { status: 'disabled', data: null }
    }

    const googlePath = loadGoogleTokenPath()
    const twitchPath = loadTwitchTokenPath()

    if (!googlePath || !twitchPath) {
      return { status: 'not-consented', data: null }
    }

    // Token files present but live API calls are out of this build scope (Boss-consent pending).
    // When consent lands, this section will be wired to the actual HTTP clients.
    return { status: 'not-consented', data: null }
  } catch {
    return { status: 'error', data: null }
  }
}
