import type { ZeppDailySnapshot } from './contract.js'

export interface DataDateViolation {
  /** Which timestamped field disagreed with snapshot.date ('sleep' | 'workout[i]'). */
  field: string
  /** The day the snapshot claims to cover (snapshot.date). */
  expected: string
  /** The Budapest local day the field's own timestamp actually resolves to. */
  actual: string
}

// Budapest local date (YYYY-MM-DD) from an ISO timestamp. Mirrors the n8n transform's
// localDate() so this guard and the producer agree on day boundaries (approximate DST:
// +2h Mar-Oct, +1h Nov-Feb -- good enough for a log-only sanity check).
function budapestLocalDate(iso: string): string | undefined {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return undefined
  const mo = d.getUTCMonth() + 1
  const off = mo >= 3 && mo <= 10 ? 2 : 1
  return new Date(d.getTime() + off * 3600 * 1000).toISOString().slice(0, 10)
}

// Log-only data-date guard (card 75337cdc, Q2). After the transform F1 fix, each record is
// filed under its own local day, so a snapshot's timestamped fields must resolve to
// snapshot.date. A mismatch means the producer mis-filed the day (an F1 regression, or a
// pre-F1 producer still keying the date off the push time) -- surface it so the goal-calc
// never silently reads a snapshot whose real data belongs to another day.
//
// Sleep is validated on its WAKE day (endAt); workouts on their startAt. Activity/steps
// carry no timestamp once the transform has summed them, so they are correct by construction
// upstream and are not re-checked here. sourceSyncedAt is deliberately NOT consulted --
// keying the date off the sync time is the original F1 bug this whole line fixes.
export function validateDataDate(snap: ZeppDailySnapshot): DataDateViolation[] {
  const out: DataDateViolation[] = []
  if (snap.sleep?.endAt) {
    const d = budapestLocalDate(snap.sleep.endAt)
    if (d && d !== snap.date) out.push({ field: 'sleep', expected: snap.date, actual: d })
  }
  if (snap.workouts) {
    snap.workouts.forEach((w, i) => {
      if (!w.startAt) return
      const d = budapestLocalDate(w.startAt)
      if (d && d !== snap.date) out.push({ field: `workout[${i}]`, expected: snap.date, actual: d })
    })
  }
  return out
}

export function hasDataDateViolation(v: DataDateViolation[]): boolean {
  return v.length > 0
}
