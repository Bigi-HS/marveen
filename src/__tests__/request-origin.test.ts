import { describe, it, expect } from 'vitest'
import { classifyRequestOrigin } from '../web/dashboard-auth.js'

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
