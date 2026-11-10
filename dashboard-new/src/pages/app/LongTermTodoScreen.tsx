import { useEffect, useRef, useState } from 'react'
import { fetchLongTermTodos } from '@/lib/api-app'
import { useEventStream } from '@/hooks/useEventStream'
import { Skeleton } from '@/components/Skeleton'
import type { MemoryEntry } from '@/lib/api-app'

const POLL_INTERVAL_MS = 30_000

export function LongTermTodoScreen() {
  const [items, setItems] = useState<MemoryEntry[] | undefined>(undefined)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const { revisions } = useEventStream()
  const prevRevisionRef = useRef<number>(-1)

  function load() {
    fetchLongTermTodos()
      .then((data) => { setItems(data); setFetchError(null) })
      .catch((err) => { setFetchError((err as Error).message ?? 'Ismeretlen hiba') })
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const rev = Object.values(revisions).reduce((s, v) => s + v, 0)
    if (prevRevisionRef.current === -1) { prevRevisionRef.current = rev; return }
    if (rev === prevRevisionRef.current) return
    prevRevisionRef.current = rev
    load()
  }, [revisions])

  if (items === undefined && fetchError === null) {
    return (
      <div data-testid="longtermtodos-loading" className="space-y-4">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    )
  }

  if (fetchError && items === undefined) {
    return (
      <div data-testid="longtermtodos-error" className="rounded-xl border border-red-800/40 bg-red-900/10 p-4">
        <p className="text-sm text-red-400">{fetchError}</p>
      </div>
    )
  }

  const list = items!

  if (list.length === 0) {
    return (
      <div data-testid="longtermtodos-empty" className="rounded-xl border border-border p-6 text-center">
        <p className="text-sm text-text-muted">Nincs hosszú távú terv.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-text">Hosszú Távú Tervek</h2>
      <div data-testid="longtermtodos-items" className="space-y-3 overflow-y-auto">
        {list.map((item, index) => (
          <div
            key={item.id}
            data-testid={`longtermtodos-item-${index}`}
            className="surface-card rounded-xl border border-border p-4"
          >
            <p className="text-sm text-text">{item.content}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
