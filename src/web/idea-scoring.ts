// Impact/Effort scoring for the idea box (card 9c089734). A score is an integer
// 1..5 (1 = low, 5 = high) or null (unscored). Kept pure and dependency-free so
// the validator is unit-testable and shared by the /api/ideas route layer.

export type ScoreParse = { ok: true; value: number | null } | { ok: false }

// Coerce a raw request value into a stored score. null / undefined / '' clear the
// score (=> null). A string that is a clean integer in range is accepted. Anything
// out of the 1..5 integer range (0, 6, -1, 2.5, 'abc', objects) is rejected so the
// route can answer 400 rather than persist garbage.
export function parseScore(raw: unknown): ScoreParse {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false }
  return { ok: true, value: n }
}
