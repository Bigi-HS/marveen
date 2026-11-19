import { describe, it, expect } from 'vitest'
import { sanitizeCardIds, type CardCodeResolver } from '../web/routes/notify-sanitize.js'

// Card 930bba69 AC-P1-1: a Boss-facing Telegram notify payload must not carry a
// raw 8-char hex card-id after the rewrite. The rewrite is MEMBERSHIP-RESOLVE, not
// a blind strip: only tokens that resolve to a KNOWN card are rewritten (to the
// card's PREFIX-NNN code, or a placeholder when the card has no code). Any other
// 8-hex-shaped token (a git short SHA, a random hex) is NOT a card id and must pass
// through UNCHANGED -- blind-stripping it would mangle legitimate data (regression).

// Fixture resolver: 930bba69 -> coded card; feedcafe -> known card with no code;
// everything else -> not a card (null).
const resolve: CardCodeResolver = (id) => {
  if (id === '930bba69') return { code: 'ENG-042' }
  if (id === 'feedcafe') return { code: null }
  return null
}

describe('sanitizeCardIds (membership-resolve, not blind strip)', () => {
  it('FIXTURE 1: a known card-id is rewritten to its PREFIX-NNN code', () => {
    const out = sanitizeCardIds('Card 930bba69 is ready', resolve)
    expect(out).toBe('Card ENG-042 is ready')
    expect(out).not.toMatch(/\b[0-9a-f]{8}\b/)
  })

  it('FIXTURE 2: a known card-id with NO code becomes a placeholder, never raw hex', () => {
    const out = sanitizeCardIds('See feedcafe for detail', resolve)
    expect(out).toBe('See [card] for detail')
    expect(out).not.toContain('feedcafe')
  })

  it('FIXTURE 3: a non-card 8-hex token (git short SHA) passes through UNCHANGED', () => {
    // deadbeef is a valid 8-hex shape but resolves to no card -> must NOT be touched.
    const out = sanitizeCardIds('Fixed in deadbeef on develop', resolve)
    expect(out).toBe('Fixed in deadbeef on develop')
  })

  it('leaves a full 40-hex git SHA untouched (no internal word-boundary match)', () => {
    const sha = 'da838ff2e640e28b1c2d3e4f5061728394a5b6c7d8e9f0a1'.slice(0, 40)
    const out = sanitizeCardIds(`commit ${sha} merged`, resolve)
    expect(out).toBe(`commit ${sha} merged`)
  })

  it('rewrites multiple distinct card-ids in one message', () => {
    const out = sanitizeCardIds('930bba69 blocks feedcafe', resolve)
    expect(out).toBe('ENG-042 blocks [card]')
  })

  it('does not match a 7-char short SHA (too short) or a 9+ char hex run', () => {
    expect(sanitizeCardIds('abc1234 and 1234567890ab', resolve)).toBe('abc1234 and 1234567890ab')
  })

  it('guarantees NO known card-id survives as raw hex in the output (AC invariant)', () => {
    const known = ['930bba69', 'feedcafe']
    const out = sanitizeCardIds('930bba69 / feedcafe / deadbeef', resolve)
    for (const id of known) expect(out).not.toContain(id)
    // the non-card hex intentionally remains:
    expect(out).toContain('deadbeef')
  })
})

describe('sanitizeCardIds -- grey-zone decisions (card 930bba69, membership-principle)', () => {
  it('UPPERCASE: an uppercase form of a known card-id is lowercased, resolved, and rewritten', () => {
    // 930BBA69 is the same card as 930bba69 -- it must not leak as raw hex.
    expect(sanitizeCardIds('Card 930BBA69 ready', resolve)).toBe('Card ENG-042 ready')
    expect(sanitizeCardIds('Card 930BBA69 ready', resolve)).not.toContain('930BBA69')
  })

  it('UPPERCASE non-card hex stays unchanged (resolve-negative, original case preserved)', () => {
    expect(sanitizeCardIds('token DEADBEEF here', resolve)).toBe('token DEADBEEF here')
  })

  it('0x-PREFIX: a 0x-prefixed id is NOT matched -> left as-is (documented boundary)', () => {
    // The `0x` binds the run (no word boundary before the 8-hex), so it is a distinct
    // token, not a card-id. Accepted: no fleet caller emits 0x-prefixed card-ids.
    expect(sanitizeCardIds('hex 0x930bba69 value', resolve)).toBe('hex 0x930bba69 value')
  })

  it('URL PATH: a known card-id inside a link path IS rewritten (invariant holds in links)', () => {
    expect(sanitizeCardIds('open https://d/card/930bba69/detail', resolve)).toBe(
      'open https://d/card/ENG-042/detail',
    )
  })
})

describe('sanitizeCardIds -- MarkdownV2 escaping of the injected replacement', () => {
  // The caller formats the surrounding text for its parse_mode and escapes its own
  // specials. When we INJECT a replacement, the code (ENG-042 has a '-') and the
  // placeholder ('[card]' has '[' ']') contain MarkdownV2 specials that would break
  // the caller's message if emitted raw. Escape the injected token to its parse_mode.
  it('escapes the PREFIX-NNN hyphen under MarkdownV2', () => {
    const out = sanitizeCardIds('Card 930bba69 ready', resolve, 'MarkdownV2')
    expect(out).toBe('Card ENG\\-042 ready')
  })

  it('escapes the placeholder brackets under MarkdownV2', () => {
    const out = sanitizeCardIds('See feedcafe', resolve, 'MarkdownV2')
    expect(out).toBe('See \\[card\\]')
  })

  it('does NOT escape under plain text (no parse_mode)', () => {
    expect(sanitizeCardIds('Card 930bba69', resolve)).toBe('Card ENG-042')
  })

  it('does NOT escape under HTML parse_mode (hyphen/brackets are not HTML-special)', () => {
    expect(sanitizeCardIds('Card 930bba69', resolve, 'HTML')).toBe('Card ENG-042')
  })
})
