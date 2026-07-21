// Pure formatting helpers (no DOM, no React) -- the testable core behind the
// timestamps and text previews the UI renders.

/** Convert an epoch-seconds value to milliseconds (backend kanban/messages use s). */
export function secToMs(epochSeconds: number): number {
  return epochSeconds * 1000
}

/**
 * Compact relative timestamp in Hungarian ("most", "2 perce", "5 órája",
 * "3 napja") -- the dashboard reads in Boss's language. `tsMs` is epoch
 * MILLISECONDS. Null/absent -> "Soha" (AC-F0-3 edge case). Future timestamps
 * (clock skew) clamp to "most".
 */
export function relativeTime(tsMs: number | null | undefined, nowMs: number): string {
  if (tsMs == null) return 'Soha'
  const deltaSec = Math.floor((nowMs - tsMs) / 1000)
  if (deltaSec < 0) return 'most'
  if (deltaSec < 45) return 'most'
  const min = Math.floor(deltaSec / 60)
  if (min < 1) return 'most'
  if (min < 60) return `${min} perce`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} órája`
  const day = Math.floor(hr / 24)
  return `${day} napja`
}

/** Truncate to `max` chars, appending an ellipsis when cut. Shorter strings pass through. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + '…'
}
