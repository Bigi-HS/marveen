import { describe, it, expect } from 'vitest'
import { classifyRequestOrigin, rateLimitKey } from '../web/dashboard-auth.js'

// AC8 of the remote-access spec: the request log must tag remote/local + source
// IP. classifyRequestOrigin is the pure decision behind that tag.
describe('classifyRequestOrigin', () => {
  it('is local with the socket peer when there is no X-Forwarded-For', () => {
    expect(classifyRequestOrigin(undefined, '127.0.0.1')).toEqual({ remote: false, sourceIp: '127.0.0.1' })
  })

  it('is local + unknown when neither XFF nor socket address is available', () => {
    expect(classifyRequestOrigin(undefined, undefined)).toEqual({ remote: false, sourceIp: 'unknown' })
  })

  it('is remote with the client IP when X-Forwarded-For is set (Tailscale Serve)', () => {
    expect(classifyRequestOrigin('100.64.0.5', '127.0.0.1')).toEqual({ remote: true, sourceIp: '100.64.0.5' })
  })

  it('takes the FIRST hop of a multi-hop X-Forwarded-For', () => {
    expect(classifyRequestOrigin('100.64.0.5, 10.0.0.1', '127.0.0.1')).toEqual({ remote: true, sourceIp: '100.64.0.5' })
  })

  it('handles X-Forwarded-For delivered as an array', () => {
    expect(classifyRequestOrigin(['100.64.0.9, 10.0.0.1', 'x'], '127.0.0.1')).toEqual({ remote: true, sourceIp: '100.64.0.9' })
  })

  it('trims surrounding whitespace on the client IP', () => {
    expect(classifyRequestOrigin('  100.64.0.7  ', '127.0.0.1')).toEqual({ remote: true, sourceIp: '100.64.0.7' })
  })

  it('treats an empty / whitespace-only X-Forwarded-For as local', () => {
    expect(classifyRequestOrigin('', '127.0.0.1')).toEqual({ remote: false, sourceIp: '127.0.0.1' })
    expect(classifyRequestOrigin('   ', '127.0.0.1')).toEqual({ remote: false, sourceIp: '127.0.0.1' })
  })
})

// card 511f519f -- the rate-limit bucket key MUST be the unspoofable socket
// peer, NEVER the X-Forwarded-For-derived sourceIp from classifyRequestOrigin.
// The dashboard binds 127.0.0.1, so any local process can forge an arbitrary
// X-Forwarded-For; keying the login brute-force limiter on that would let an
// attacker mint unlimited distinct buckets and bypass the limit entirely.
describe('rateLimitKey -- socket-peer-only (XFF-spoof hardening, card 511f519f)', () => {
  it('returns the socket peer address', () => {
    expect(rateLimitKey('127.0.0.1')).toBe('127.0.0.1')
    expect(rateLimitKey('100.64.0.5')).toBe('100.64.0.5')
  })

  it('falls back to "unknown" when the socket peer is unavailable', () => {
    expect(rateLimitKey(undefined)).toBe('unknown')
    expect(rateLimitKey('')).toBe('unknown')
  })

  it('does NOT read X-Forwarded-For -- the key cannot be influenced by request headers', () => {
    // rateLimitKey takes ONLY the socket peer; there is no header parameter, so
    // a forged XFF cannot fan a single peer into many buckets. Same peer in =>
    // same key out, regardless of any header an attacker controls.
    const peer = '127.0.0.1'
    expect(rateLimitKey(peer)).toBe(rateLimitKey(peer))
    // and it is the socket peer, NOT the spoofable XFF first-hop a co-located
    // attacker would set to look like distinct remote clients.
    expect(rateLimitKey(peer)).not.toBe(classifyRequestOrigin('100.64.0.5', peer).sourceIp)
  })
})
