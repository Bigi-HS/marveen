// Pure formatting helpers (no DOM, no React) -- the testable core behind the
// timestamps and text previews the UI renders.

/** Convert an epoch-seconds value to milliseconds (backend kanban/messages use s). */
export function secToMs(epochSeconds: number): number {
  return epochSeconds * 1000
}

/**
 * Compact relative timestamp ("just now", "2m ago", "5h ago", "3d ago").
 * `tsMs` is epoch MILLISECONDS. Null/absent -> "Never" (AC-F0-3 edge case).
 * Future timestamps (clock skew) clamp to "just now".
 */
export function relativeTime(tsMs: number | null | undefined, nowMs: number): string {
  if (tsMs == null) return 'Never'
  const deltaSec = Math.floor((nowMs - tsMs) / 1000)
  if (deltaSec < 0) return 'just now'
  if (deltaSec < 45) return 'just now'
  const min = Math.floor(deltaSec / 60)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

/** Truncate to `max` chars, appending an ellipsis when cut. Shorter strings pass through. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + '…'
}
