import { usePolling } from '@/hooks/usePolling'
import { isAuthError } from '@/lib/auth-error'
import { AuthRequired } from '@/components/AuthRequired'
import { Skeleton } from '@/components/Skeleton'
import type { WorkoutPlan, AppCalendarEvent, JournalEntry } from '@/lib/api-app'

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

function today(): string {
  return new Date().toLocaleDateString('hu-HU', { weekday: 'long', month: 'long', day: 'numeric' })
}

function WorkoutCard({ plan, loading }: { plan: WorkoutPlan | null | undefined; loading: boolean }) {
  if (loading) return <Skeleton className="h-20 w-full rounded-xl" />
  if (!plan || plan.exercises.length === 0) {
    return (
      <div className="surface-card rounded-xl border border-border p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Edzés</p>
        <p className="mt-1 text-sm text-text-muted">Pihenőnap</p>
      </div>
    )
  }
  return (
    <div className="surface-card rounded-xl border border-border p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Edzés ma</p>
      <p className="mt-1 font-medium text-text">{plan.exercises.length} gyakorlat</p>
      <ul className="mt-2 space-y-0.5 text-sm text-text-muted">
        {plan.exercises.slice(0, 3).map((ex, i) => (
          <li key={i}>
            {ex.name} &mdash; {ex.sets ?? '?'}&times;{ex.reps ?? '?'}
            {ex.weight != null && ex.weight > 0 ? ` @ ${ex.weight}${ex.unit ?? 'kg'}` : ''}
          </li>
        ))}
        {plan.exercises.length > 3 && (
          <li className="text-xs">+{plan.exercises.length - 3} további</li>
        )}
      </ul>
    </div>
  )
}

function CalendarCard({
  events,
  loading,
}: {
  events: AppCalendarEvent[] | undefined
  loading: boolean
}) {
  if (loading) return <Skeleton className="h-20 w-full rounded-xl" />
  const list = events ?? []
  return (
    <div className="surface-card rounded-xl border border-border p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Naptár</p>
      {list.length === 0 ? (
        <p className="mt-1 text-sm text-text-muted">Nincs esemény ma</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {list.slice(0, 4).map((ev) => (
            <li key={ev.id} className="flex items-baseline gap-2">
              <span className="shrink-0 text-xs text-text-muted">{formatTime(ev.start)}</span>
              <span className="truncate text-text">{ev.summary}</span>
            </li>
          ))}
          {list.length > 4 && (
            <li className="text-xs text-text-muted">+{list.length - 4} további</li>
          )}
        </ul>
      )}
    </div>
  )
}

function JournalCard({
  entries,
  loading,
}: {
  entries: JournalEntry[] | undefined
  loading: boolean
}) {
  if (loading) return <Skeleton className="h-16 w-full rounded-xl" />
  const last = entries?.[0]
  return (
    <div className="surface-card rounded-xl border border-border p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Utolsó napló</p>
      {!last ? (
        <p className="mt-1 text-sm text-text-muted">Nincs bejegyzés</p>
      ) : (
        <p className="mt-1 line-clamp-2 text-sm text-text">{last.content}</p>
      )}
    </div>
  )
}

export function AppHome() {
  const workout = usePolling<WorkoutPlan | null>('/api/workout/plan', { intervalMs: 60_000 })
  const calendar = usePolling<{ events: AppCalendarEvent[] }>('/api/calendar/today', { intervalMs: 300_000 })
  const journal = usePolling<{ entries: JournalEntry[] }>('/api/journal/entries?limit=1', { intervalMs: 300_000 })

  if ([workout, calendar, journal].some((s) => isAuthError(s.error))) {
    return <AuthRequired />
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-muted capitalize">{today()}</p>
      <WorkoutCard plan={workout.data} loading={workout.loading && workout.data === undefined} />
      <CalendarCard
        events={calendar.data?.events}
        loading={calendar.loading && calendar.data === undefined}
      />
      <JournalCard
        entries={journal.data?.entries}
        loading={journal.loading && journal.data === undefined}
      />
    </div>
  )
}
