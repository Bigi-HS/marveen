/**
 * Cumulative Flow Diagram (card b60d578c, DASH-030).
 * Pure-SVG stacked area chart -- no external charting library.
 * Data source: GET /api/kanban/cfd -> { snapshots: CfdSnapshotRow[] }
 *
 * Stack order (bottom to top): done, in_progress, waiting, planned.
 * A widening "waiting" band = the fleet is blocked.
 */
import { usePolling } from '@/hooks/usePolling'

interface CfdSnapshotRow {
  date: string
  planned: number
  in_progress: number
  waiting: number
  done: number
}

interface CfdResponse {
  snapshots: CfdSnapshotRow[]
}

// Status band order (bottom to top of the stack), with colours.
const BANDS: Array<{ key: keyof Omit<CfdSnapshotRow, 'date'>; label: string; fill: string; stroke: string }> = [
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

function buildPath(
  xs: number[],
  topYs: number[],
  botYs: number[],
): string {
  if (xs.length === 0) return ''
  const fwd = xs.map((x, i) => `${x},${topYs[i]}`).join(' L ')
  const bwd = [...xs].reverse().map((x, i) => `${x},${botYs[xs.length - 1 - i]}`).join(' L ')
  return `M ${fwd} L ${bwd} Z`
}

function formatDateLabel(iso: string): string {
  // "2026-08-26" -> "08-26"
  return iso.slice(5)
}

/** Pure stacked-area CFD. Exported for testing. */
export function KanbanCFD({ snapshots }: { snapshots: CfdSnapshotRow[] }) {
  if (snapshots.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-lg border border-border bg-bg-elevated text-xs text-text-muted">
        Nincs adat -- holnaptol jon az elso napi pillanatkep.
      </div>
    )
  }

  const n = snapshots.length
  const totals = snapshots.map(s => s.planned + s.in_progress + s.waiting + s.done)
  const maxTotal = Math.max(...totals, 1)

  const xs = snapshots.map((_, i) => PAD.left + (i / Math.max(n - 1, 1)) * CHART_W)

  // Cumulative stacks: for each point, sum of bands below.
  // Index in BANDS is bottom=0 (done) to top=3 (planned).
  const yScaled = (count: number) =>
    PAD.top + CHART_H - (count / maxTotal) * CHART_H

  // Compute cumulative bottom and top for each band at each x.
  const cumulativeTop: number[][] = []
  let cumBase = snapshots.map(() => 0)

  for (const band of BANDS) {
    const vals = snapshots.map(s => s[band.key] as number)
    const cumTop = vals.map((v, i) => cumBase[i] + v)
    cumulativeTop.push(cumTop)
    cumBase = cumTop
  }

  // Y-axis tick labels (0, max/2, max)
  const yTicks = [0, Math.round(maxTotal / 2), maxTotal]

  // X-axis date labels: show at most 7 evenly spread labels
  const labelStep = Math.max(1, Math.floor(n / 7))
  const xLabels: Array<{ x: number; label: string }> = []
  for (let i = 0; i < n; i += labelStep) {
    xLabels.push({ x: xs[i], label: formatDateLabel(snapshots[i].date) })
  }
  if (n > 1 && (n - 1) % labelStep !== 0) {
    xLabels.push({ x: xs[n - 1], label: formatDateLabel(snapshots[n - 1].date) })
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

        {/* Stacked area bands (bottom to top = index 0 to 3) */}
        {BANDS.map((band, bi) => {
          const topYs = cumulativeTop[bi].map(v => yScaled(v))
          const botYs = bi === 0
            ? cumulativeTop[bi].map(() => yScaled(0))
            : cumulativeTop[bi - 1].map(v => yScaled(v))
          const d = buildPath(xs, topYs, botYs)
          return (
            <g key={band.key}>
              <path d={d} fill={band.fill} />
              <polyline
                points={xs.map((x, i) => `${x},${topYs[i]}`).join(' ')}
                fill="none" stroke={band.stroke} strokeWidth={1.5}
              />
            </g>
          )
        })}

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
      <KanbanCFD snapshots={cfd.data?.snapshots ?? []} />
    </div>
  )
}
