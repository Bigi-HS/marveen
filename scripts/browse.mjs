#!/usr/bin/env node
// Headless-browser reader (card 3d14e258, Boss-GO).
//
// Render any URL with a real headless Chromium so we can read JS-heavy or
// bot-walled pages (e.g. Reddit) that WebFetch/curl cannot. The dashboard's
// external-curl guard blocks direct fetches to non-localhost; this is the
// sanctioned, isolated way to pull rendered page text or a screenshot.
//
//   node scripts/browse.mjs <url> [text|screenshot]
//
//   text        (default) print the rendered document.body.innerText to stdout.
//   screenshot  same innerText to stdout PLUS a full-page PNG written under
//               /tmp; the file path is printed to stderr.
//
// SECURITY (the page is UNTRUSTED):
//   - Only http/https URLs are allowed.
//   - An SSRF guard blocks localhost and private / link-local / loopback IPs
//     (incl. the 169.254.169.254 cloud-metadata address) so the page cannot be
//     pointed at internal services. DNS-rebinding is out of scope for this
//     trusted-agent CLI (no resolve-then-connect gap to exploit from argv).
//   - No secrets are ever typed into the page and nothing from the environment
//     is forwarded; we only read.
//   - Chromium runs headless with a realistic desktop UA; teardown always runs
//     in a finally block so a launched browser can never leak.
//
// Playwright is imported DYNAMICALLY inside browse() so the pure helpers
// (parseArgs / validateTargetUrl / isBlockedHost) load and unit-test without the
// dependency or a Chromium binary installed. Install for real with:
//   npx playwright install chromium

const VALID_MODES = new Set(['text', 'screenshot'])

// A realistic, current desktop Chrome UA -- many bot walls 403 the default
// HeadlessChrome token.
const REALISTIC_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36'

const NAV_TIMEOUT_MS = 30_000
const SETTLE_TIMEOUT_MS = 10_000

/**
 * Parse argv (everything after `node browse.mjs`). Returns { url, mode }.
 * Throws on a missing URL or an unknown mode.
 */
export function parseArgs(argv) {
  const args = argv.filter((a) => a !== undefined && a !== null)
  if (args.length === 0) {
    throw new Error('usage: browse.mjs <url> [text|screenshot]')
  }
  const url = args[0]
  const mode = args[1] ?? 'text'
  if (!VALID_MODES.has(mode)) {
    throw new Error(`mode must be one of: ${[...VALID_MODES].join(', ')}`)
  }
  return { url, mode }
}

/** Parse a dotted-quad into 4 octets, or null if not a valid IPv4 literal. */
function parseIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const octets = m.slice(1).map((n) => Number(n))
  if (octets.some((o) => o > 255)) return null
  return octets
}

function isPrivateIpv4(octets) {
  const [a, b] = octets
  if (a === 127) return true // loopback 127.0.0.0/8
  if (a === 10) return true // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // private 172.16.0.0/12
  if (a === 192 && b === 168) return true // private 192.168.0.0/16
  if (a === 169 && b === 254) return true // link-local 169.254.0.0/16 (incl. metadata)
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a === 0) return true // 0.0.0.0/8 "this host"
  return false
}

/**
 * True when a hostname must be refused as an SSRF target: localhost names and
 * literal loopback / private / link-local IPv4 and IPv6 addresses.
 */
export function isBlockedHost(hostname) {
  if (!hostname) return true
  let host = hostname.toLowerCase()

  // Localhost name forms.
  if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.localhost')) {
    return true
  }

  // IPv6 literals arrive with surrounding brackets from URL.hostname only when
  // taken raw; URL strips them for .hostname, but guard both.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)

  const v4 = parseIpv4(host)
  if (v4) return isPrivateIpv4(v4)

  // IPv6 forms.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true // loopback / unspecified
    // IPv4-mapped IPv6: ::ffff:a.b.c.d (dotted) OR ::ffff:HHHH:HHHH (hex). Node's
    // WHATWG URL normalizes the dotted form to hex (`::ffff:127.0.0.1` ->
    // `::ffff:7f00:1`), so the hex branch is the one that actually fires through
    // a parsed URL -- the old `split(':').pop()` only matched dotted-quad and let
    // `::ffff:a9fe:a9fe` (169.254.169.254 metadata) through (Thor S1 / Chad). Decode
    // the embedded IPv4 from EITHER form and apply the v4 rules.
    if (host.startsWith('::ffff:')) {
      const rest = host.slice('::ffff:'.length)
      let v4 = parseIpv4(rest)
      if (!v4) {
        const hx = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest)
        if (hx) {
          const hi = parseInt(hx[1], 16)
          const lo = parseInt(hx[2], 16)
          v4 = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]
        }
      }
      if (v4) return isPrivateIpv4(v4)
    }
    if (host.startsWith('fe80')) return true // link-local fe80::/10
    if (host.startsWith('fc') || host.startsWith('fd')) return true // ULA fc00::/7
    return false
  }

  return false
}

/**
 * Validate a raw URL string for browsing. Returns a URL object on success;
 * throws on a non-http(s) scheme or an SSRF-blocked host.
 */
export function validateTargetUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`not a valid URL: ${rawUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`only http/https URLs are allowed (got ${parsed.protocol})`)
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(`refused: ${parsed.hostname} is a private/loopback/link-local host (SSRF guard)`)
  }
  return parsed
}

// Default launcher: dynamically import Playwright's Chromium. Isolated here so
// tests inject a fake and never need the real dependency or a browser binary.
async function defaultLauncher() {
  const { chromium } = await import('playwright')
  return chromium.launch({ headless: true })
}

/**
 * Render a validated URL and return { text, screenshotPath }. The browser is
 * always torn down in a finally block.
 *
 * @param {object}   opts
 * @param {string}   opts.url             raw URL (re-validated here).
 * @param {string}   opts.mode            'text' | 'screenshot'.
 * @param {Function} [opts.launch]        async () => browser (injected in tests).
 * @param {string}   [opts.outDir]        screenshot dir (default /tmp).
 * @param {string}   [opts.stamp]         filename stamp (default caller-supplied; avoids Date in core).
 */
export async function browse({ url, mode, launch = defaultLauncher, outDir = '/tmp', stamp }) {
  const target = validateTargetUrl(url)
  const browser = await launch()
  try {
    const context = await browser.newContext({ userAgent: REALISTIC_UA })
    const page = await context.newPage()
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)

    // Condition-based waits, never a fixed sleep: navigate until the DOM is
    // parsed, then wait for the network to go idle (best-effort -- some pages
    // never fully idle, so a bounded timeout falls through to whatever rendered).
    await page.goto(target.href, { waitUntil: 'domcontentloaded' })
    try {
      await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS })
    } catch {
      // networkidle never reached within the budget: proceed with current DOM.
    }

    const text = await page.evaluate(() => document.body?.innerText ?? '')

    let screenshotPath = null
    if (mode === 'screenshot') {
      const safeStamp = stamp ?? String(target.hostname).replace(/[^a-z0-9.-]/gi, '_')
      screenshotPath = `${outDir}/browse-${safeStamp}.png`
      await page.screenshot({ path: screenshotPath, fullPage: true })
    }
    return { text, screenshotPath }
  } finally {
    await browser.close()
  }
}

export async function main(argv, { launch, outDir, stamp, out = process.stdout, err = process.stderr } = {}) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (e) {
    err.write(`${e.message}\n`)
    return 2
  }
  try {
    const { text, screenshotPath } = await browse({ url: parsed.url, mode: parsed.mode, launch, outDir, stamp })
    out.write(text + '\n')
    if (screenshotPath) err.write(`screenshot: ${screenshotPath}\n`)
    return 0
  } catch (e) {
    err.write(`browse failed: ${e.message}\n`)
    // Exit 1 for a refused/invalid target (config error), 3 for a render/runtime failure.
    return /SSRF guard|only http|not a valid URL/.test(e.message) ? 1 : 3
  }
}

// Direct-run entrypoint (skipped when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)))
}
