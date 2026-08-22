import { describe, it, expect } from 'vitest'
import {
  mergeState,
  awaitsSeat,
  MY_SEAT,
  SEAT_CHIP,
  SEAT_GLYPH,
  CI_CHIP,
  MERGE_CHIP,
} from './gate'
import type { GateBoardPr, GateSeat } from '@/types/gate'

function pr(over: Partial<GateBoardPr> = {}): GateBoardPr {
  return {
    pr_number: 100,
    author: 'dave',
    seats: { thor: 'none', dave: 'none', chad: 'none' },
    ci_status: 'none',
    ci_required: false,
    override_active: false,
    chad_reviewed: false,
    merge_ready: false,
    last_activity: 1_700_000_000,
    ...over,
  }
}

function seats(thor: GateSeat, dave: GateSeat, chad: GateSeat) {
  return { thor, dave, chad }
}

describe('mergeState (non-authoritative badge derivation)', () => {
  it('is "pending" when the gate is not yet satisfied', () => {
    expect(mergeState(pr())).toBe('pending')
    expect(mergeState(pr({ seats: seats('approved', 'none', 'none') }))).toBe('pending')
  })

  it('is "blocked" when any seat blocked (and no override)', () => {
    expect(mergeState(pr({ seats: seats('approved', 'blocked', 'none') }))).toBe('blocked')
    expect(mergeState(pr({ seats: seats('blocked', 'none', 'none') }))).toBe('blocked')
  })

  it('is "ready" only when merge_ready AND Chad has acted (confident green)', () => {
    expect(
      mergeState(pr({ merge_ready: true, chad_reviewed: true, seats: seats('approved', 'approved', 'approved') })),
    ).toBe('ready')
  })

  it('is "ready-unverified" when merge_ready but Chad has NOT acted (cautious, never solid green)', () => {
    // Board derived required=thor+dave only; a security PR could still need Chad.
    expect(
      mergeState(pr({ merge_ready: true, chad_reviewed: false, seats: seats('approved', 'approved', 'none') })),
    ).toBe('ready-unverified')
  })

  it('is "override" whenever an override is active -- never green, even if seats blocked', () => {
    // marveen guard: an override forced merge_ready; surface it distinctly, not as go.
    expect(mergeState(pr({ override_active: true, merge_ready: true }))).toBe('override')
    expect(
      mergeState(pr({ override_active: true, merge_ready: true, chad_reviewed: true, seats: seats('blocked', 'approved', 'none') })),
    ).toBe('override')
  })
})

describe('merge badge invariant: uncertain state is never the confident-green "ready"', () => {
  it('override and ready-unverified both resolve to a non-"ready" state', () => {
    const override = mergeState(pr({ override_active: true, merge_ready: true, chad_reviewed: true }))
    const unverified = mergeState(pr({ merge_ready: true, chad_reviewed: false }))
    expect(override).not.toBe('ready')
    expect(unverified).not.toBe('ready')
  })

  it('only the ready chip is solid-filled green; ready-unverified has no fill', () => {
    expect(MERGE_CHIP.ready).toMatch(/bg-status-done/)
    expect(MERGE_CHIP['ready-unverified']).toMatch(/bg-transparent/)
    expect(MERGE_CHIP['ready-unverified']).not.toMatch(/bg-status-done\//)
  })

  it('hierarchy: only "ready" wears confident green text; "ready-unverified" is muted + dashed', () => {
    // The tentative state keeps a green hint on the border only, never green text,
    // so a "Ready (Chad?)" can never read as the confident go that "Merge ready" is.
    expect(MERGE_CHIP.ready).toMatch(/text-status-done/)
    expect(MERGE_CHIP['ready-unverified']).not.toMatch(/text-status-done/)
    expect(MERGE_CHIP['ready-unverified']).toMatch(/text-text-muted/)
    expect(MERGE_CHIP['ready-unverified']).toMatch(/border-dashed/)
  })
})

describe('seat glyphs (legibility): each verdict is a distinct, legible mark', () => {
  it('approved/blocked/pending are visually distinct and pending is not a middot', () => {
    expect(SEAT_GLYPH.approved).toBe('✓')
    expect(SEAT_GLYPH.blocked).toBe('✕')
    // A mid-dot ('·') nearly disappears at seat size; pending uses a stroke instead.
    expect(SEAT_GLYPH.none).not.toBe('·')
    const glyphs = Object.values(SEAT_GLYPH)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })
})

describe('awaitsSeat (my-seats-now filter)', () => {
  it('true when the reviewer seat is still pending', () => {
    expect(awaitsSeat(pr({ seats: seats('approved', 'none', 'none') }), 'dave')).toBe(true)
  })

  it('false once the reviewer has approved or blocked', () => {
    expect(awaitsSeat(pr({ seats: seats('none', 'approved', 'none') }), 'dave')).toBe(false)
    expect(awaitsSeat(pr({ seats: seats('none', 'blocked', 'none') }), 'dave')).toBe(false)
  })

  it('false under an active override (the gate is short-circuited)', () => {
    expect(awaitsSeat(pr({ override_active: true, seats: seats('none', 'none', 'none') }), 'dave')).toBe(false)
  })

  it('MY_SEAT is dave (this dashboard is the engineer seat)', () => {
    expect(MY_SEAT).toBe('dave')
  })
})

describe('palette tokens only (INV-3): no inline hex in any chip map', () => {
  it('seat/ci/merge chips use token classes, never hex', () => {
    for (const cls of [...Object.values(SEAT_CHIP), ...Object.values(CI_CHIP), ...Object.values(MERGE_CHIP)]) {
      expect(cls).not.toMatch(/#[0-9a-fA-F]{3,6}/)
    }
  })
})
