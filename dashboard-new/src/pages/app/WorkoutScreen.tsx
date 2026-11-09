import { useEffect, useState } from 'react'
import { fetchWorkoutPlan, postWorkoutCheckin } from '@/lib/api-app'
import { Skeleton } from '@/components/Skeleton'
import { cn } from '@/lib/cn'
import type { WorkoutPlan, WorkoutExercise } from '@/lib/api-app'

function formatExercise(ex: WorkoutExercise): string {
  const parts: string[] = []
  if (ex.sets != null && ex.reps != null) {
    parts.push(`${ex.sets}×${ex.reps}`)
  } else if (ex.sets != null) {
    parts.push(`${ex.sets} sor`)
  }
  if (ex.weight != null && ex.weight > 0) {
    parts.push(`@${ex.weight}${ex.unit ?? 'kg'}`)
  }
  return parts.join(' ')
}

function buildCheckinNote(exercises: WorkoutExercise[], checkedIndices: Set<number>): string {
  const names = exercises
    .filter((_, i) => checkedIndices.has(i))
    .map((ex) => {
      const detail = formatExercise(ex)
      return detail ? `${ex.name} (${detail})` : ex.name
    })
  return `Kész: ${names.join(', ')}`
}

export function WorkoutScreen() {
  const [plan, setPlan] = useState<WorkoutPlan | null | undefined>(undefined)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    fetchWorkoutPlan()
      .then((p) => setPlan(p))
      .catch((err) => {
        setFetchError((err as Error).message ?? 'Ismeretlen hiba')
        setPlan(null)
      })
  }, [])

  function toggleExercise(index: number) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  async function handleSubmit() {
    if (!plan || checked.size === 0 || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const note = buildCheckinNote(plan.exercises, checked)
      await postWorkoutCheckin(note)
      setSubmitted(true)
    } catch (err) {
      setSubmitError((err as Error).message ?? 'Ismeretlen hiba')
    } finally {
      setSubmitting(false)
    }
  }

  if (plan === undefined && !fetchError) {
    return (
      <div data-testid="workout-loading" className="space-y-3">
        <Skeleton className="h-8 w-48 rounded-lg" />
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="rounded-xl border border-border p-6 text-center">
        <p className="text-sm text-status-error">Hiba: {fetchError}</p>
      </div>
    )
  }

  if (!plan || plan.exercises.length === 0) {
    return (
      <div className="surface-card rounded-xl border border-border p-6 text-center">
        <p className="text-2xl">🏖</p>
        <p className="mt-2 font-medium text-text">Pihenőnap</p>
        <p className="mt-1 text-sm text-text-muted">Nincs mai edzésterv</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Mai edzés</p>
        {plan.notes && <p className="mt-0.5 text-sm text-text-muted">{plan.notes}</p>}
      </div>

      <ul className="space-y-2">
        {plan.exercises.map((ex, i) => {
          const isChecked = checked.has(i)
          return (
            <li key={i}>
              <label
                className={cn(
                  'surface-card flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors',
                  isChecked
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/50',
                )}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleExercise(i)}
                  className="mt-0.5 h-4 w-4 cursor-pointer accent-primary"
                  disabled={submitted || submitting}
                />
                <div className="min-w-0 flex-1">
                  <p className={cn('font-medium', isChecked ? 'text-primary line-through' : 'text-text')}>
                    {ex.name}
                  </p>
                  {(ex.sets != null || ex.weight != null) && (
                    <p className="text-sm text-text-muted">{formatExercise(ex)}</p>
                  )}
                </div>
                {isChecked && (
                  <span className="shrink-0 text-lg text-primary" aria-hidden>
                    ✓
                  </span>
                )}
              </label>
            </li>
          )
        })}
      </ul>

      {submitted ? (
        <div className="rounded-xl bg-primary/10 p-4 text-center">
          <p className="font-medium text-primary">✓ Elküldve Hibikinek</p>
          <p className="mt-0.5 text-xs text-text-muted">
            {checked.size} gyakorlat befejezve
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {submitError && (
            <p className="text-sm text-status-error">Hiba: {submitError}</p>
          )}
          <button
            type="button"
            disabled={checked.size === 0 || submitting}
            onClick={handleSubmit}
            className={cn(
              'w-full rounded-xl px-4 py-3 font-medium transition-colors',
              checked.size > 0 && !submitting
                ? 'bg-primary text-white hover:bg-primary/90'
                : 'cursor-not-allowed bg-surface-alt text-text-muted',
            )}
          >
            {submitting ? 'Küldés...' : `Edzés kész (${checked.size}/${plan.exercises.length})`}
          </button>
        </div>
      )}
    </div>
  )
}
