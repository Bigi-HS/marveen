import type { GateBoardPr, GateCiStatus, GateReviewer, GateSeat } from '@/types/gate'

// Derived, testable presentation logic for the gate board. Palette tokens only
// (INV-3 / AC-G4): no inline hex -- every class resolves to a tokens.css var. The
// palette has no red token, so attention states (blocked/fail) borrow brand orange
// and stay distinct via their TEXT label, not colour alone (a11y, mirrors status.ts).

/**
 * The reviewer seat this dashboard belongs to. The "my seats now" filter surfaces
 * PRs still awaiting a verdict from this seat.
 */
export const MY_SEAT: GateReviewer = 'dave'

export const REVIEWERS: readonly GateReviewer[] = ['thor', 'dave', 'chad']

export const REVIEWER_LABEL: Record<GateReviewer, string> = {
  thor: 'Thor',
  dave: 'Dave',
  chad: 'Chad',
}

/**
 * Merge-readiness state for the badge. The board is NON-AUTHORITATIVE, so the badge
 * must never present a confident "go" (solid green) when the board's own inputs are
 * uncertain (marveen guard, mirrors the PR#400 backend caveat):
 *   - override_active: merge_ready is true only because a human override forced it,
 *     not because the seats passed -> 'override' (distinct, not green).
 *   - merge_ready && !chad_reviewed: the board can't see the PR file list, so it
 *     derived the required set WITHOUT Chad; a security-sensitive PR could still
 *     need Chad at the real gate -> 'ready-unverified' (cautious outline, not solid).
 * Only merge_ready with Chad having acted (and no override) earns confident 'ready'.
 */
export type MergeState = 'blocked' | 'override' | 'ready' | 'ready-unverified' | 'pending'

export function mergeState(pr: GateBoardPr): MergeState {
  if (pr.override_active) return 'override'
  const anyBlocked =
    pr.seats.thor === 'blocked' || pr.seats.dave === 'blocked' || pr.seats.chad === 'blocked'
  if (anyBlocked) return 'blocked'
  if (pr.merge_ready) return pr.chad_reviewed ? 'ready' : 'ready-unverified'
  return 'pending'
}

/**
 * True when `reviewer`'s seat is still awaiting a verdict on this PR (drives the
 * "my seats now" filter). An active override short-circuits the gate, so those PRs
 * no longer wait on any seat.
 */
export function awaitsSeat(pr: GateBoardPr, reviewer: GateReviewer): boolean {
  return !pr.override_active && pr.seats[reviewer] === 'none'
}

export const SEAT_LABEL: Record<GateSeat, string> = {
  approved: 'Approved',
  blocked: 'Blocked',
  none: 'Pending',
}

export const SEAT_GLYPH: Record<GateSeat, string> = {
  approved: '✓',
  blocked: '✕',
  none: '·',
}

export const SEAT_CHIP: Record<GateSeat, string> = {
  approved: 'text-status-done bg-status-done/10 ring-1 ring-inset ring-status-done/30',
  blocked: 'text-primary bg-primary/15 ring-1 ring-inset ring-primary/40',
  none: 'text-text-muted bg-border/20 ring-1 ring-inset ring-border',
}

export const CI_LABEL: Record<GateCiStatus, string> = {
  pass: 'CI pass',
  fail: 'CI fail',
  none: 'CI none',
}

export const CI_CHIP: Record<GateCiStatus, string> = {
  pass: 'text-status-done bg-status-done/10 ring-1 ring-inset ring-status-done/30',
  fail: 'text-primary bg-primary/15 ring-1 ring-inset ring-primary/40',
  none: 'text-text-muted bg-border/20 ring-1 ring-inset ring-border',
}

export const MERGE_LABEL: Record<MergeState, string> = {
  ready: 'Merge ready',
  'ready-unverified': 'Ready (Chad?)',
  override: 'Override',
  blocked: 'Blocked',
  pending: 'Pending',
}

// 'ready' is the ONLY solid-filled green; 'ready-unverified' is a dashed outline so
// an uncertain state can never read as a confident go at a glance (marveen guard).
export const MERGE_CHIP: Record<MergeState, string> = {
  ready: 'text-status-done bg-status-done/15 ring-1 ring-inset ring-status-done/40',
  'ready-unverified': 'text-status-done bg-transparent border border-dashed border-status-done/50',
  override: 'text-primary bg-primary/10 ring-1 ring-inset ring-primary/30',
  blocked: 'text-primary bg-primary/15 ring-1 ring-inset ring-primary/40',
  pending: 'text-text-muted bg-border/25 ring-1 ring-inset ring-border',
}
