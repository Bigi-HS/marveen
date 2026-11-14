import { relativeTime, secToMs } from '@/lib/format'
import { agentDisplayName } from '@/lib/display-name'
import { EmptyState } from '../EmptyState'
import {
  agentTotalTokens,
  cacheHitRatio,
  formatTokens,
  formatUsd,
  sortByCost,
  spendRatePerHour,
  totalCostUsd,
} from '@/lib/cost'
import type { CostBoard as CostBoardData } from '@/types/cost'

/** Per-agent cost board (card e230c097 slice 2). Read-only observability over
 *  GET /api/token-usage/cost: per-agent spend (sorted high-first), the phantom
 *  parent->child lineage rollup, and an unrated-model gap notice. The measured
 *  companion of the N1 token-discipline. */
export function CostBoard({ board, nowMs }: { board: CostBoardData; nowMs: number }) {
  const agents = sortByCost(board.agents)
  const total = totalCostUsd(board.agents)

  if (agents.length === 0) {
    return <EmptyState message="Nincs költség-adat. A token-gyűjtő még nem futott, vagy nincs forgalom." />
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-text">
          Költség <span className="font-normal text-text-muted">({agents.length} ágens)</span>
        </h2>
        <span className="text-lg font-semibold tabular-nums text-text">{formatUsd(total)}</span>
      </div>

      {board.unrated.length > 0 && (
        <p className="rounded-lg border border-status-waiting/40 bg-status-waiting/10 px-3 py-2 text-xs text-status-waiting">
          {board.unrated.length} nem árazott modell-sor (ismeretlen/átnevezett modell) — a költség ennyivel alulbecsült lehet.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
              <th scope="col" className="py-2 pr-3 font-medium">Ágens</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Hívások</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Tokenek</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Cache</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Költség</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Burn/ó</th>
              <th scope="col" className="py-2 pl-2 text-right font-medium">Utolsó</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.agent} className="border-b border-border/50 last:border-0">
                <td className="py-2 pr-3 font-medium text-text">{agentDisplayName(a.agent) ?? a.agent}</td>
                <td className="px-2 py-2 text-right tabular-nums text-text-muted">{a.totalCalls.toLocaleString('en-US')}</td>
                <td className="px-2 py-2 text-right tabular-nums text-text-muted">{formatTokens(agentTotalTokens(a))}</td>
                <td className="px-2 py-2 text-right tabular-nums text-text-muted">{Math.round(cacheHitRatio(a) * 100)}%</td>
                <td className="px-2 py-2 text-right font-medium tabular-nums text-text">{formatUsd(a.totalCostUsd)}</td>
                <td className="px-2 py-2 text-right tabular-nums text-text-muted">{formatUsd(spendRatePerHour(a))}/ó</td>
                <td className="py-2 pl-2 text-right font-mono text-xs tabular-nums text-text-muted">
                  {relativeTime(secToMs(a.lastSeen), nowMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {board.lineage.length > 0 && (
        <div className="space-y-1">
          <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Phantom orchestráció (szülő → gyerek költség)
          </h3>
          <table className="w-full border-collapse text-sm">
            <tbody>
              {board.lineage.map((l) => (
                <tr key={l.parent} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 pr-3 text-text">{agentDisplayName(l.parent) ?? l.parent}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-text-muted">
                    {l.childSessions} session / {l.childCalls.toLocaleString('en-US')} hívás
                  </td>
                  <td className="py-1.5 pl-2 text-right font-medium tabular-nums text-text">{formatUsd(l.childCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
