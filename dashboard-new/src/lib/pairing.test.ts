import { describe, it, expect } from 'vitest'
import { buildPairingUrl } from './pairing'

// The QR code and the copy-paste link must encode the SAME pairing URL the Tauri
// app already consumes: `<origin>/v2/#token=<jwt>`. These tests pin that contract so
// the QR can never drift from the link (card 408c4248, v2 Phase 1 onboarding).
describe('buildPairingUrl', () => {
  it('builds the canonical /v2 hash-token URL from an origin and token', () => {
    expect(buildPairingUrl('http://localhost:3420', 'abc.def.ghi')).toBe(
      'http://localhost:3420/v2/#token=abc.def.ghi'
    )
  })

  it('works for a Tailscale origin and a realistic base64url JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtb2JpbGUtYXBwIn0.s-9_aBcD'
    expect(buildPairingUrl('http://100.64.0.1:3420', jwt)).toBe(
      `http://100.64.0.1:3420/v2/#token=${jwt}`
    )
  })

  it('does not double the slash when the origin carries a trailing slash', () => {
    expect(buildPairingUrl('http://host:3420/', 'tok')).toBe(
      'http://host:3420/v2/#token=tok'
    )
  })

  it('leaves base64url JWT characters untouched (no percent-encoding)', () => {
    // JWTs only use A-Za-z0-9-_ and '.', all hash-safe; the app parses the raw value.
    const tok = 'aA0-_.bB1-_'
    expect(buildPairingUrl('http://x', tok)).toBe('http://x/v2/#token=aA0-_.bB1-_')
  })

  it('refuses to build a token-less pairing URL', () => {
    expect(() => buildPairingUrl('http://x', '')).toThrow()
    // whitespace-only is still empty
    expect(() => buildPairingUrl('http://x', '   ')).toThrow()
  })

  it('requires a non-empty origin', () => {
    expect(() => buildPairingUrl('', 'tok')).toThrow()
  })
})
