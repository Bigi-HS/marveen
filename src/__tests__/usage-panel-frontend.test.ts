/**
 * Source-text tests for DASH-003 (7fe5662f): Claude usage panel frontend.
 *
 * The backend refresher + /api/usage/current are already covered by executable
 * tests (usage-refresher.test.ts, usage-route.test.ts). This file guards the
 * frontend panel the same way the fitness-widget test guards its renderer:
 * asserting the key rendering / state-mapping / page-wiring logic is present in
 * web/app.js and web/index.html, so a regression in the panel breaks the gate.
 *
 * Covered invariants:
 *  - sidebar link + hidden #usagePage exist (index.html)
 *  - switchPage routes 'usage' -> loadClaudeUsage and tears the poll down on exit
 *  - the panel fetches ONLY the derived /api/usage/current (no credential path)
 *  - all three 503 reasons (feature-absent / auth-expired / unavailable) map to
 *    a distinct, non-crashing UI state
 *  - the countdown formatter clamps past resets to "most" and rejects invalid
 *  - the usage-% color thresholds (danger >= 90, warn >= 70) are present
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '..', '..', 'web', 'index.html'), 'utf-8')

describe('Claude usage panel frontend (DASH-003, 7fe5662f)', () => {
  it('index.html has the sidebar link + hidden usage page', () => {
    expect(HTML).toContain('data-page="usage"')
    expect(HTML).toContain('id="usagePage"')
    // the page is hidden by default (lazy-rendered on navigate)
    expect(HTML).toMatch(/id="usagePage"[^>]*hidden/)
  })

  it('switchPage routes the usage page to loadClaudeUsage', () => {
    expect(APP).toContain("if (pageId === 'usage') loadClaudeUsage()")
  })

  it('switchPage stops the usage poll when navigating away (no leaked interval)', () => {
    expect(APP).toContain("if (pageId !== 'usage') stopUsagePoll()")
    expect(APP).toContain('function stopUsagePoll()')
  })

  it('panel fetches ONLY the derived endpoint (credential never crosses the wire)', () => {
    expect(APP).toContain("fetch('/api/usage/current'")
    // the raw credential endpoints must never be called from the frontend
    expect(APP).not.toContain('claude.ai/api/organizations')
    expect(APP).not.toContain('sessionKey')
    expect(APP).not.toContain('cf_clearance')
  })

  it('maps all three 503 reasons to a distinct UI state', () => {
    expect(APP).toContain("'feature-absent'")
    expect(APP).toContain("'auth-expired'")
    expect(APP).toContain("'unavailable'")
    expect(APP).toContain('USAGE_REASON_META')
  })

  it('renders a stale notice when the cached usage is flagged stale', () => {
    expect(APP).toContain('data.stale')
  })

  it('countdown formatter rejects invalid timestamps and clamps past resets', () => {
    expect(APP).toContain('function formatResetCountdown(')
    // invalid / missing -> '' so the caller can hide, not render NaN
    expect(APP).toContain('if (Number.isNaN(t)) return')
    // never negative: a past reset reads "most"
    expect(APP).toContain('Math.max(0, t - nowMs)')
    expect(APP).toContain("return 'most'")
  })

  it('usage-% color uses design tokens with danger/warn thresholds', () => {
    expect(APP).toContain('function usagePctColor(')
    expect(APP).toContain('if (pct >= 90) return')
    expect(APP).toContain('if (pct >= 70) return')
    expect(APP).toContain('var(--danger)')
    // no raw hex in the threshold colors
    expect(APP).not.toMatch(/usagePctColor[\s\S]{0,200}#[0-9a-fA-F]{3,6}/)
  })
})
