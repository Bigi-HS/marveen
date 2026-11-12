// Pairing-URL construction shared by the copy-paste link and the QR code, so the
// two can never drift (card 408c4248, v2 Phase 1 onboarding). The Tauri app reads
// the token from the URL hash: `<origin>/v2/#token=<jwt>`.

/**
 * Build the canonical pairing URL the installable app consumes.
 * @param origin page origin, e.g. `http://localhost:3420` or a Tailscale host.
 * @param token the 90-day app-token JWT.
 */
export function buildPairingUrl(origin: string, token: string): string {
  if (!origin) {
    throw new Error('buildPairingUrl: origin is required')
  }
  if (!token.trim()) {
    throw new Error('buildPairingUrl: token is required')
  }
  // JWTs are base64url (A-Za-z0-9-_ plus '.'), all safe in a URL fragment, and the
  // app parses the raw value -- so we intentionally do not percent-encode.
  const base = origin.replace(/\/+$/, '')
  return `${base}/v2/#token=${token}`
}
