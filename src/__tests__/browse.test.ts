import { describe, it, expect } from 'vitest'
// The deliverable is an ESM script; its pure helpers import without Playwright
// or a Chromium binary (card 3d14e258).
import {
  parseArgs,
  isBlockedHost,
  validateTargetUrl,
  browse,
  main,
} from '../../scripts/browse.mjs'

describe('parseArgs', () => {
  it('requires a URL', () => {
    expect(() => parseArgs([])).toThrow(/usage/)
  })

  it('defaults mode to text', () => {
    expect(parseArgs(['https://example.com'])).toEqual({ url: 'https://example.com', mode: 'text' })
  })

  it('accepts an explicit screenshot mode', () => {
    expect(parseArgs(['https://example.com', 'screenshot'])).toEqual({
      url: 'https://example.com',
      mode: 'screenshot',
    })
  })

  it('rejects an unknown mode', () => {
    expect(() => parseArgs(['https://example.com', 'pdf'])).toThrow(/mode must be one of/)
  })
})

describe('isBlockedHost (SSRF guard)', () => {
  const blocked = [
    'localhost',
    'LOCALHOST',
    'foo.localhost',
    'localhost.localdomain',
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '100.64.0.1', // CGNAT lower bound
    '100.127.255.255', // CGNAT upper bound (M1 BVA)
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback (dotted form)
    '::ffff:7f00:1', // IPv4-mapped loopback (HEX form -- the URL-normalized shape; Thor S1 / Chad)
    '::ffff:a9fe:a9fe', // IPv4-mapped 169.254.169.254 metadata (hex form)
    '::ffff:a00:1', // IPv4-mapped 10.0.0.1 (hex form, private)
    '::ffff:c0a8:101', // IPv4-mapped 192.168.1.1 (hex form, private)
    '[::ffff:7f00:1]', // bracketed (URL.hostname returns brackets for IPv6)
  ]
  for (const h of blocked) {
    it(`blocks ${h}`, () => expect(isBlockedHost(h)).toBe(true))
  }

  const allowed = [
    'example.com',
    'www.reddit.com',
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1', // just below the private 172.16/12 range
    '172.32.0.1', // just above it
    '192.169.0.1', // not 192.168
    '11.0.0.1',
    '100.63.255.255', // just below CGNAT 100.64/10 (M1 BVA)
    '100.128.0.0', // just above CGNAT 100.64/10 (M1 BVA)
    '2606:4700:4700::1111', // public IPv6 (Cloudflare)
    '::ffff:808:808', // IPv4-mapped 8.8.8.8 (hex form, public -> allowed; Thor's allowed example)
    '::ffff:c000:201', // IPv4-mapped 192.0.2.1 = TEST-NET-1 (RFC 5737), NOT private -> allowed by scope (see re-gate note to Thor)
  ]
  for (const h of allowed) {
    it(`allows ${h}`, () => expect(isBlockedHost(h)).toBe(false))
  }
})

describe('validateTargetUrl', () => {
  it('rejects a non-URL string', () => {
    expect(() => validateTargetUrl('not a url')).toThrow(/not a valid URL/)
  })

  it('rejects non-http(s) schemes', () => {
    expect(() => validateTargetUrl('ftp://example.com')).toThrow(/only http\/https/)
    expect(() => validateTargetUrl('file:///etc/passwd')).toThrow(/only http\/https/)
  })

  it('rejects an SSRF-blocked host', () => {
    expect(() => validateTargetUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/SSRF guard/)
    expect(() => validateTargetUrl('http://localhost:3420/api/admin/rotate-token')).toThrow(/SSRF guard/)
  })

  it('accepts a public https URL and returns a URL object', () => {
    const u = validateTargetUrl('https://www.reddit.com/r/programming')
    expect(u.hostname).toBe('www.reddit.com')
  })

  // End-to-end through the WHATWG URL parser, which normalizes [::ffff:a.b.c.d]
  // to the hex form -- the real path the SSRF guard must catch (Thor S1 / Chad).
  it('rejects [::ffff:169.254.169.254] (metadata) via validateTargetUrl', () => {
    expect(() => validateTargetUrl('http://[::ffff:169.254.169.254]/latest/meta-data/')).toThrow(/SSRF guard/)
  })

  it('rejects [::ffff:127.0.0.1] (loopback) via validateTargetUrl', () => {
    expect(() => validateTargetUrl('http://[::ffff:127.0.0.1]:3420/')).toThrow(/SSRF guard/)
  })

  it('rejects [::1] via validateTargetUrl', () => {
    expect(() => validateTargetUrl('http://[::1]/')).toThrow(/SSRF guard/)
  })

  it('accepts a public IPv4-mapped host [::ffff:8.8.8.8] via validateTargetUrl', () => {
    expect(() => validateTargetUrl('http://[::ffff:8.8.8.8]/')).not.toThrow()
  })
})

// A fake Playwright browser so browse() runs with no real Chromium. Records
// teardown so we can prove the finally-block close always fires.
function fakeBrowser(opts: {
  text?: string
  evalThrow?: boolean
  idleThrow?: boolean
} = {}) {
  const calls = { closed: false, screenshotPath: null as string | null, ua: null as string | null }
  const page = {
    setDefaultNavigationTimeout() {},
    async goto() {},
    async waitForLoadState() {
      if (opts.idleThrow) throw new Error('networkidle timeout')
    },
    async evaluate() {
      if (opts.evalThrow) throw new Error('eval fail')
      return opts.text ?? 'RENDERED TEXT'
    },
    async screenshot({ path }: { path: string }) {
      calls.screenshotPath = path
    },
  }
  const context = { async newPage() { return page } }
  const browser = {
    async newContext({ userAgent }: { userAgent: string }) {
      calls.ua = userAgent
      return context
    },
    async close() { calls.closed = true },
  }
  return { launch: async () => browser, calls }
}

describe('browse (injected launcher, no Chromium)', () => {
  it('returns rendered innerText in text mode', async () => {
    const fake = fakeBrowser({ text: 'hello world' })
    const r = await browse({ url: 'https://example.com', mode: 'text', launch: fake.launch })
    expect(r.text).toBe('hello world')
    expect(r.screenshotPath).toBeNull()
    expect(fake.calls.closed).toBe(true)
    expect(fake.calls.ua).toMatch(/Chrome\/\d+/) // realistic UA, not HeadlessChrome default
  })

  it('writes a screenshot path under outDir in screenshot mode', async () => {
    const fake = fakeBrowser()
    const r = await browse({
      url: 'https://example.com',
      mode: 'screenshot',
      launch: fake.launch,
      outDir: '/tmp',
      stamp: 'unit',
    })
    expect(r.screenshotPath).toBe('/tmp/browse-unit.png')
    expect(fake.calls.screenshotPath).toBe('/tmp/browse-unit.png')
  })

  it('still tears down the browser when rendering throws (finally)', async () => {
    const fake = fakeBrowser({ evalThrow: true })
    await expect(browse({ url: 'https://example.com', mode: 'text', launch: fake.launch })).rejects.toThrow(
      /eval fail/,
    )
    expect(fake.calls.closed).toBe(true)
  })

  it('falls through to the rendered DOM when networkidle never settles', async () => {
    const fake = fakeBrowser({ text: 'partial', idleThrow: true })
    const r = await browse({ url: 'https://example.com', mode: 'text', launch: fake.launch })
    expect(r.text).toBe('partial')
    expect(fake.calls.closed).toBe(true)
  })

  it('refuses an SSRF target before launching a browser', async () => {
    let launched = false
    const launch = async () => {
      launched = true
      return fakeBrowser().launch()
    }
    await expect(browse({ url: 'http://127.0.0.1/', mode: 'text', launch })).rejects.toThrow(/SSRF guard/)
    expect(launched).toBe(false)
  })
})

describe('main (exit codes)', () => {
  function sink() {
    let s = ''
    return { write: (x: string) => { s += x }, get: () => s }
  }

  it('exits 2 on a usage error', async () => {
    const err = sink()
    expect(await main([], { err: err as any })).toBe(2)
    expect(err.get()).toMatch(/usage/)
  })

  it('exits 1 on an SSRF-refused target', async () => {
    const err = sink()
    const code = await main(['http://169.254.169.254/'], { err: err as any })
    expect(code).toBe(1)
    expect(err.get()).toMatch(/SSRF guard/)
  })

  it('exits 0 and prints innerText on success', async () => {
    const fake = fakeBrowser({ text: 'page body' })
    const out = sink()
    const code = await main(['https://example.com'], { launch: fake.launch, out: out as any })
    expect(code).toBe(0)
    expect(out.get()).toBe('page body\n')
  })

  it('prints the screenshot path to stderr in screenshot mode', async () => {
    const fake = fakeBrowser({ text: 'x' })
    const out = sink()
    const err = sink()
    const code = await main(['https://example.com', 'screenshot'], {
      launch: fake.launch, out: out as any, err: err as any, outDir: '/tmp', stamp: 'main',
    })
    expect(code).toBe(0)
    expect(err.get()).toMatch(/screenshot: \/tmp\/browse-main\.png/)
  })
})
