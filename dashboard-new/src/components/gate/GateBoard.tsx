import { useState } from 'react'
import { cn } from '@/lib/cn'
import { relativeTime, secToMs } from '@/lib/format'
import { agentDisplayName } from '@/lib/display-name'
import { EmptyState } from '../EmptyState'
import { SeatCell } from './SeatCell'
import { CiCell } from './CiCell'
import { MergeBadge } from './MergeBadge'
import { awaitsSeat, MY_SEAT, REVIEWERS, REVIEWER_LABEL } from '@/lib/gate'
import type { GateBoardPr } from '@/types/gate'

/** Open-PR x reviewer-seat matrix (card 87c32aa4). Read-only overview of the merge
 *  gate: per-seat verdicts, CI, and a non-authoritative merge-ready badge, with a
 *  "my seats now" filter for the PRs still awaiting this dashboard's seat (dave). */
export function GateBoard({ prs, nowMs }: { prs: GateBoardPr[]; nowMs: number }) {
  const [mineOnly, setMineOnly] = useState(false)
  const mineCount = prs.filter((pr) => awaitsSeat(pr, MY_SEAT)).length
  const rows = mineOnly ? prs.filter((pr) => awaitsSeat(pr, MY_SEAT)) : prs

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-text">
          Merge gate <span className="font-normal text-text-muted">({prs.length} nyitott PR)</span>
        </h2>
        <button
          type="button"
          onClick={() => setMineOnly((v) => !v)}
          aria-pressed={mineOnly}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors',
            mineOnly ? 'border-primary text-primary' : 'border-border text-text-muted hover:text-text',
          )}
        >
          Az én székeim most
          <span
            className={cn(
              'rounded px-1 text-[10px]',
              mineOnly ? 'bg-primary text-bg-deep' : 'bg-border/40 text-text-muted',
            )}
          >
            {mineCount}
          </span>
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState message={mineOnly ? 'Nincs rád váró szék. Tiszta víz.' : 'Nincs nyitott PR a gate-en.'} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">
                  PR
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Szerző
                </th>
                {REVIEWERS.map((r) => (
                  <th key={r} scope="col" className="px-2 py-2 text-center font-medium">
                    {REVIEWER_LABEL[r]}
                  </th>
                ))}
                <th scope="col" className="px-2 py-2 text-center font-medium">
                  CI
                </th>
                <th scope="col" className="px-2 py-2 text-center font-medium">
                  Állapot
                </th>
                <th scope="col" className="py-2 pl-2 text-right font-medium">
                  Aktivitás
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((pr) => (
                <tr key={pr.pr_number} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-3 font-mono font-medium tabular-nums text-text">#{pr.pr_number}</td>
                  <td className="py-2 pr-3 text-text-muted">{agentDisplayName(pr.author) ?? '—'}</td>
                  {REVIEWERS.map((r) => (
                    <td key={r} className="px-2 py-2 text-center">
                      <SeatCell seat={pr.seats[r]} />
                    </td>
                  ))}
                  <td className="px-2 py-2 text-center">
                    <CiCell status={pr.ci_status} required={pr.ci_required} />
                  </td>
                  <td className="px-2 py-2 text-center">
                    <MergeBadge pr={pr} />
                  </td>
                  <td className="py-2 pl-2 text-right font-mono text-xs tabular-nums text-text-muted">
                    {relativeTime(secToMs(pr.last_activity), nowMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
