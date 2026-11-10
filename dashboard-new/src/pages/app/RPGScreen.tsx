import { useEffect, useRef, useState } from 'react'
import { fetchRpgStats } from '@/lib/api-app'
import { useEventStream } from '@/hooks/useEventStream'
import { Skeleton } from '@/components/Skeleton'
import { cn } from '@/lib/cn'
import type { RpgStatsResponse } from '@/lib/api-app'

const SOURCE_LABEL: Record<string, string> = {
  workout_checkin: 'Edzés',
  kanban_done:     'Feladat',
  daily_log:       'Napló',
  streak_bonus:    'Streak bónusz',
  heartbeat:       'Heartbeat',
  coding_session:  'Kódolás',
  goal_milestone:  'Mérföldkő',
}

const POLL_INTERVAL_MS = 30_000

function XpBar({ xpInLevel, xpForNextLevel }: { xpInLevel: number; xpForNextLevel: number }) {
  const pct = xpForNextLevel > 0 ? Math.min(100, (xpInLevel / xpForNextLevel) * 100) : 0
  return (
    <div className="space-y-1">
      <div
        data-testid="rpg-xp-bar"
        className="h-3 w-full overflow-hidden rounded-full bg-bg"
      >
        <div
          data-testid="rpg-xp-bar-fill"
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p data-testid="rpg-xp-label" className="text-xs text-text-muted">
        {xpInLevel} / {xpForNextLevel} XP a következő szintig
      </p>
    </div>
  )
}

function SourceBreakdown({ breakdown }: { breakdown: Record<string, number> }) {
  const entries = Object.entries(breakdown).sort(([, a], [, b]) => b - a)
  if (entries.length === 0) return null

  return (
    <div data-testid="rpg-source-breakdown" className="surface-card rounded-xl border border-border p-4">
      <p className="mb-3 text-sm font-medium text-text">XP forrásai</p>
      <div className="space-y-2">
        {entries.map(([source, total]) => (
          <div
            key={source}
            data-testid={`rpg-source-${source}`}
            className="flex items-center justify-between gap-2"
          >
            <span className="text-xs text-text-muted">{SOURCE_LABEL[source] ?? source}</span>
            <span className="text-xs font-medium text-text">{total} XP</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function AchievementList({ achievements }: { achievements: RpgStatsResponse['recentAchievements'] }) {
  return (
    <div data-testid="rpg-achievements" className="surface-card rounded-xl border border-border p-4">
      <p className="mb-3 text-sm font-medium text-text">Kitüntetések</p>
      {achievements.length === 0 ? (
        <p className="text-xs text-text-muted">Még nincs kitüntetés. Szerezz XP-t!</p>
      ) : (
        <div className="space-y-2">
          {achievements.map((a) => (
            <div key={a.id} className="flex items-center gap-2">
              <span className="text-base" aria-hidden>🏆</span>
              <span className="text-xs text-text">{a.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function RPGScreen() {
  const [stats, setStats] = useState<RpgStatsResponse | undefined>(undefined)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const { revisions } = useEventStream()
  const prevRevisionRef = useRef<number>(-1)

  function load() {
    fetchRpgStats()
      .then((data) => { setStats(data); setFetchError(null) })
      .catch((err) => { setFetchError((err as Error).message ?? 'Ismeretlen hiba') })
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  // SSE-driven refetch: any revision bump triggers an immediate reload
  useEffect(() => {
    const rev = Object.values(revisions).reduce((s, v) => s + v, 0)
    if (prevRevisionRef.current === -1) { prevRevisionRef.current = rev; return }
    if (rev === prevRevisionRef.current) return
    prevRevisionRef.current = rev
    load()
  }, [revisions])

  if (stats === undefined && fetchError === null) {
    return (
      <div data-testid="rpg-loading" className="space-y-4">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    )
  }

  if (fetchError && stats === undefined) {
    return (
      <div data-testid="rpg-error" className="rounded-xl border border-red-800/40 bg-red-900/10 p-4">
        <p className="text-sm text-red-400">{fetchError}</p>
      </div>
    )
  }

  const s = stats!

  return (
    <div className="space-y-4">
      {/* Level + XP */}
      <div className="surface-card rounded-xl border border-border p-4">
        <div className="mb-3 flex items-center gap-4">
          <div
            data-testid="rpg-level-badge"
            className={cn(
              'flex h-14 w-14 shrink-0 items-center justify-center rounded-full',
              'bg-accent text-bg text-xl font-bold shadow-glow ring-2 ring-accent',
            )}
          >
            {s.level}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text">{s.level}. szint</p>
            <p data-testid="rpg-total-xp" className="text-xs text-text-muted">
              {s.totalXp} XP összesen
            </p>
          </div>
        </div>
        <XpBar xpInLevel={s.xpInLevel} xpForNextLevel={s.xpForNextLevel} />
      </div>

      {/* Streak + combo */}
      <div className="grid grid-cols-2 gap-3">
        <div className="surface-card flex flex-col items-center rounded-xl border border-border p-4">
          <span className="text-2xl" aria-hidden>🔥</span>
          <p
            data-testid="rpg-streak"
            className="mt-1 text-xl font-bold text-text"
          >
            {s.streak}
          </p>
          <p className="text-xs text-text-muted">napos streak</p>
        </div>
        <div className="surface-card flex flex-col items-center rounded-xl border border-border p-4">
          <span className="text-2xl" aria-hidden>⚡</span>
          <p
            data-testid="rpg-combo"
            className="mt-1 text-xl font-bold text-text"
          >
            {s.combo}
          </p>
          <p className="text-xs text-text-muted">mai esemény</p>
        </div>
      </div>

      {/* Source breakdown */}
      {Object.keys(s.sourceBreakdown).length > 0 && (
        <SourceBreakdown breakdown={s.sourceBreakdown} />
      )}

      {/* Achievements */}
      <AchievementList achievements={s.recentAchievements} />
    </div>
  )
}
