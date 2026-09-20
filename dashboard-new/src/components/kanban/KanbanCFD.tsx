/**
 * Cumulative Flow Diagram (card b60d578c, DASH-030).
 * Pure-SVG stacked area chart -- no external charting library.
 * Data source: GET /api/kanban/cfd -> { snapshots: CfdSnapshotRow[], series: CfdSeriesPoint[] }
 *
 * Stack order (bottom to top): done, in_progress, waiting, planned.
 * A widening "waiting" band = the fleet is blocked.
 *
 * C7b (card 27c75118): the chart consumes the gap-aware `series` when provided
 * and BREAKS the bands at days with no snapshot (present=false), positioning
 * points by their real calendar date. This prevents the old behaviour of
 * silently interpolating a straight line across a missing-data day.
 */
import { usePolling } from '@/hooks/usePolling'

interface CfdSnapshotRow {
  date: string
  planned: number
  in_progress: number
  waiting: number
  done: number
  other?: number
}

export interface CfdSeriesPoint extends CfdSnapshotRow {
  present: boolean
}

interface CfdResponse {
  snapshots: CfdSnapshotRow[]
  series?: CfdSeriesPoint[]
}

type FlowKey = 'done' | 'in_progress' | 'waiting' | 'planned'

// Status band order (bottom to top of the stack), with colours.
const BANDS: Array<{ key: FlowKey; label: string; fill: string; stroke: string }> = [
  { key: 'done',        label: 'Kész',        fill: 'rgba(34,197,94,0.55)',  stroke: 'rgb(34,197,94)' },
  { key: 'in_progress', label: 'Folyamatban', fill: 'rgba(59,130,246,0.5)', stroke: 'rgb(59,130,246)' },
  { key: 'waiting',     label: 'Várakozik',   fill: 'rgba(249,115,22,0.55)', stroke: 'rgb(249,115,22)' },
  { key: 'planned',     label: 'Tervezett',   fill: 'rgba(148,163,184,0.45)', stroke: 'rgb(148,163,184)' },
]

const W = 640
const H = 200
const PAD = { top: 12, right: 16, bottom: 32, left: 36 }
const CHART_W = W - PAD.left - PAD.right
const CHART_H = H - PAD.top - PAD.bottom

/**
 * Split a series into contiguous runs of present points, returning the point
 * indices for each run. Gap points (present=false) break a run; leading,
 * trailing and interior gaps are dropped. Exported for testing (C7b).
 */
export function splitPresentRuns(points: CfdSeriesPoint[]): number[][] {
  const runs: number[][] = []
  let cur: number[] = []
  points.forEach((p, i) => {
    if (p.present) {
      cur.push(i)
    } else if (cur.length > 0) {
      runs.push(cur)
      cur = []
    }
  })
  if (cur.length > 0) runs.push(cur)
  return runs
}

function buildAreaPath(xs: number[], topYs: number[], botYs: number[]): string {
  if (xs.length === 0) return ''
  const fwd = xs.map((x, i) => `${x},${topYs[i]}`).join(' L ')
  const bwd = [...xs].reverse().map((x, i) => `${x},${botYs[xs.length - 1 - i]}`).join(' L ')
  return `M ${fwd} L ${bwd} Z`
}

function formatDateLabel(iso: string): string {
  // "2026-08-26" -> "08-26"
  return iso.slice(5)
}

function dateMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`)
}

/** Pure stacked-area CFD. Exported for testing. */
export function KanbanCFD({ snapshots, series }: { snapshots: CfdSnapshotRow[]; series?: CfdSeriesPoint[] }) {
  // Prefer the gap-aware series; otherwise treat every snapshot as present.
  const points: CfdSeriesPoint[] = series ?? snapshots.map(s => ({ ...s, present: true }))

  if (points.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-lg border border-border bg-bg-elevated text-xs text-text-muted">
        Nincs adat -- holnaptol jon az elso napi pillanatkep.
      </div>
    )
  }

  const n = points.length
  const totals = points.map(s => s.planned + s.in_progress + s.waiting + s.done)
  const maxTotal = Math.max(...totals, 1)

  // Position each point by its real calendar date so a missing day leaves a
  // visible spatial gap instead of being compressed into the next index.
  const ms = points.map(p => dateMs(p.date))
  const minMs = ms[0]
  const span = Math.max(ms[n - 1] - minMs, 1)
  const xs = ms.map(m => PAD.left + ((m - minMs) / span) * CHART_W)

  const yScaled = (count: number) =>
    PAD.top + CHART_H - (count / maxTotal) * CHART_H

  // Cumulative band tops at every point (bottom=done .. top=planned).
  const cumulativeTop: number[][] = []
  let cumBase = points.map(() => 0)
  for (const band of BANDS) {
    const vals = points.map(s => s[band.key])
    const cumTop = vals.map((v, i) => cumBase[i] + v)
    cumulativeTop.push(cumTop)
    cumBase = cumTop
  }

  // Contiguous present runs -> the bands are drawn per run so a gap breaks them.
  const runs = splitPresentRuns(points)

  const yTicks = [0, Math.round(maxTotal / 2), maxTotal]

  // X-axis date labels: show at most 7 evenly spread present points.
  const presentIdx = points.map((p, i) => (p.present ? i : -1)).filter(i => i >= 0)
  const labelStep = Math.max(1, Math.floor(presentIdx.length / 7))
  const xLabels: Array<{ x: number; label: string }> = []
  for (let k = 0; k < presentIdx.length; k += labelStep) {
    const i = presentIdx[k]
    xLabels.push({ x: xs[i], label: formatDateLabel(points[i].date) })
  }
  if (presentIdx.length > 1) {
    const last = presentIdx[presentIdx.length - 1]
    if (!xLabels.some(l => l.x === xs[last])) {
      xLabels.push({ x: xs[last], label: formatDateLabel(points[last].date) })
    }
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Cumulative Flow Diagram"
      >
        {/* Y-axis grid lines + labels */}
        {yTicks.map(tick => {
          const y = yScaled(tick)
          return (
            <g key={tick}>
              <line
                x1={PAD.left} y1={y}
                x2={PAD.left + CHART_W} y2={y}
                stroke="rgba(148,163,184,0.15)" strokeWidth={1}
              />
              <text
                x={PAD.left - 4} y={y + 4}
                textAnchor="end"
                fontSize={9}
                fill="rgba(148,163,184,0.6)"
              >{tick}</text>
            </g>
          )
        })}

        {/* Stacked area bands (bottom to top = index 0 to 3), drawn per present
            run so a data gap breaks the band instead of interpolating across. */}
        {BANDS.map((band, bi) => (
          <g key={band.key}>
            {runs.map((run, ri) => {
              const rxs = run.map(i => xs[i])
              const topYs = run.map(i => yScaled(cumulativeTop[bi][i]))
              const botYs = bi === 0
                ? run.map(() => yScaled(0))
                : run.map(i => yScaled(cumulativeTop[bi - 1][i]))
              const d = buildAreaPath(rxs, topYs, botYs)
              return (
                <g key={ri}>
                  <path d={d} fill={band.fill} />
                  <polyline
                    points={rxs.map((x, j) => `${x},${topYs[j]}`).join(' ')}
                    fill="none" stroke={band.stroke} strokeWidth={1.5}
                  />
                </g>
              )
            })}
          </g>
        ))}

        {/* X-axis baseline */}
        <line
          x1={PAD.left} y1={PAD.top + CHART_H}
          x2={PAD.left + CHART_W} y2={PAD.top + CHART_H}
          stroke="rgba(148,163,184,0.3)" strokeWidth={1}
        />

        {/* X-axis date labels */}
        {xLabels.map(({ x, label }) => (
          <text
            key={label}
            x={x} y={H - 4}
            textAnchor="middle"
            fontSize={9}
            fill="rgba(148,163,184,0.6)"
          >{label}</text>
        ))}
      </svg>

      {/* Legend */}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {[...BANDS].reverse().map(band => (
          <span key={band.key} className="flex items-center gap-1 text-[10px] text-text-muted">
            <span
              className="inline-block h-2 w-3 rounded-sm"
              style={{ background: band.stroke }}
            />
            {band.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Data-fetching wrapper, used in KanbanPage. */
export function KanbanCFDPanel() {
  const cfd = usePolling<CfdResponse>('/api/kanban/cfd', 5 * 60 * 1000)

  if (cfd.loading && !cfd.data) {
    return <div className="h-[200px] animate-pulse rounded-lg bg-bg-elevated" />
  }

  return (
    <div className="mb-4 rounded-lg border border-border bg-bg-elevated p-3">
      <p className="mb-2 text-xs font-semibold text-text-muted">Kumulatív állapotdiagram (CFD)</p>
      <KanbanCFD snapshots={cfd.data?.snapshots ?? []} series={cfd.data?.series} />
    </div>
  )
}
