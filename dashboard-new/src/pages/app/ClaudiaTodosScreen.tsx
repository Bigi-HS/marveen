import { useEffect, useState, useRef } from 'react'
import { fetchClaudiaTodos, fetchCalendarToday, markTodoDone } from '@/lib/api-app'
import { Skeleton } from '@/components/Skeleton'
import { VoiceInputButton } from '@/components/VoiceInputButton'
import { cn } from '@/lib/cn'
import type { ClaudiaTodosResponse, TodoItem, AppCalendarEvent } from '@/lib/api-app'

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

function TodoRow({
  item,
  done: externalDone,
  onDone,
}: {
  item: TodoItem
  done: boolean
  onDone: (id: string) => void
}) {
  return (
    <li
      className={cn(
        'flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors',
        externalDone ? 'border-border opacity-50' : 'border-border surface-card',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm font-medium text-text', externalDone && 'line-through')}>{item.title}</p>
        {item.detail && (
          <p className="mt-0.5 text-xs text-text-muted">{item.detail}</p>
        )}
      </div>
      {!externalDone && (
        <button
          type="button"
          onClick={() => onDone(item.id)}
          className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-text-muted hover:border-primary hover:text-primary transition-colors"
          aria-label="Kész"
        >
          Kész
        </button>
      )}
    </li>
  )
}

export function ClaudiaTodosScreen() {
  const [todos, setTodos] = useState<ClaudiaTodosResponse | undefined>(undefined)
  const [events, setEvents] = useState<AppCalendarEvent[]>([])
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set())
  const [doneError, setDoneError] = useState<string | null>(null)
  const [todoInput, setTodoInput] = useState('')
  const todoInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    Promise.all([fetchClaudiaTodos(), fetchCalendarToday()])
      .then(([t, ev]) => {
        setTodos(t)
        setEvents(ev)
      })
      .catch((err) => {
        setFetchError((err as Error).message ?? 'Ismeretlen hiba')
        setTodos({ today: [], carried: [], folyamatban: [], doneToday: [], capCount: 0 })
      })
  }, [])

  async function handleDone(id: string) {
    setDoneError(null)
    try {
      await markTodoDone(id)
      setDoneIds((prev) => new Set([...prev, id]))
    } catch (err) {
      setDoneError((err as Error).message ?? 'Hiba a feladat lezárásakor')
    }
  }

  if (todos === undefined && !fetchError) {
    return (
      <div data-testid="claudia-loading" className="space-y-3">
        <Skeleton className="h-6 w-32 rounded-lg" />
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-6 w-24 rounded-lg mt-4" />
        <Skeleton className="h-14 w-full rounded-xl" />
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

  const allOpen = [
    ...(todos?.folyamatban ?? []),
    ...(todos?.today ?? []),
    ...(todos?.carried ?? []),
  ]
  const hasAnyTodo = allOpen.length > 0 || (todos?.doneToday.length ?? 0) > 0

  function renderSection(label: string, items: TodoItem[]) {
    if (items.length === 0) return null
    return (
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</p>
        <ul className="space-y-2">
          {items.map((item) => (
            <TodoRow
              key={item.id}
              item={item}
              done={doneIds.has(item.id)}
              onDone={handleDone}
            />
          ))}
        </ul>
      </div>
    )
  }

  function handleVoiceTranscript(text: string) {
    setTodoInput(text)
    // Focus the input so the user can review/edit before submitting
    setTimeout(() => todoInputRef.current?.focus(), 50)
  }

  return (
    <div className="space-y-5">
      {/* Voice / text todo-add row */}
      <div className="surface-card flex items-center gap-2 rounded-xl border border-border px-3 py-2">
        <input
          ref={todoInputRef}
          type="text"
          value={todoInput}
          onChange={(e) => setTodoInput(e.target.value)}
          placeholder="Új feladat Claudiának..."
          className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-text-muted outline-none"
          aria-label="Új feladat szövege"
        />
        <VoiceInputButton
          onTranscript={handleVoiceTranscript}
          ariaLabel="Feladat diktálása"
        />
      </div>

      {/* Todos section */}
      <div className="space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Claudia feladatai</p>

        {doneError && (
          <p className="text-sm text-status-error">Hiba: {doneError}</p>
        )}

        {!hasAnyTodo ? (
          <div className="surface-card rounded-xl border border-border p-5 text-center">
            <p className="text-sm text-text-muted">Nincs feladat ma</p>
          </div>
        ) : (
          <div className="space-y-4">
            {renderSection('Folyamatban', todos?.folyamatban ?? [])}
            {renderSection('Ma', todos?.today ?? [])}
            {renderSection('Áthozott', todos?.carried ?? [])}
            {(todos?.doneToday.length ?? 0) > 0 && (
              <p className="text-xs text-text-muted">
                {todos!.doneToday.length} feladat kész ma
              </p>
            )}
          </div>
        )}
      </div>

      {/* Calendar section */}
      {events.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Naptár ma</p>
          <ul className="space-y-2">
            {events.map((ev) => (
              <li key={ev.id} className="surface-card flex items-baseline gap-3 rounded-xl border border-border px-4 py-3">
                <span className="shrink-0 text-xs text-text-muted">{formatTime(ev.start)}</span>
                <span className="truncate text-sm text-text">{ev.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
