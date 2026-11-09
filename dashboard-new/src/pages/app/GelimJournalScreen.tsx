import { useEffect, useState } from 'react'
import { fetchJournalEntries, postJournalEntry } from '@/lib/api-app'
import { Skeleton } from '@/components/Skeleton'
import { cn } from '@/lib/cn'
import type { JournalEntry } from '@/lib/api-app'

function formatDate(epochSeconds: number): string {
  try {
    return new Date(epochSeconds * 1000).toLocaleDateString('hu-HU', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(epochSeconds)
  }
}

function EntryCard({ entry }: { entry: JournalEntry }) {
  return (
    <li className="surface-card rounded-xl border border-border px-4 py-3 space-y-1">
      <p className="text-sm text-text leading-relaxed">{entry.content}</p>
      <div className="flex flex-wrap items-center gap-2 mt-1">
        <span className="text-xs text-text-muted">{formatDate(entry.createdAt)}</span>
        {entry.mood && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
            {entry.mood}
          </span>
        )}
        {entry.tags && (
          <span className="text-xs text-text-muted">{entry.tags}</span>
        )}
      </div>
    </li>
  )
}

export function GelimJournalScreen() {
  const [entries, setEntries] = useState<JournalEntry[] | undefined>(undefined)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [mood, setMood] = useState('')
  const [tags, setTags] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  function loadEntries() {
    return fetchJournalEntries(5)
      .then(setEntries)
      .catch((err) => {
        setFetchError((err as Error).message ?? 'Ismeretlen hiba')
        setEntries([])
      })
  }

  useEffect(() => { loadEntries() }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = content.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    setPostError(null)
    try {
      await postJournalEntry(trimmed, mood.trim() || undefined, tags.trim() || undefined)
      setContent('')
      setMood('')
      setTags('')
      await loadEntries()
    } catch (err) {
      setPostError((err as Error).message ?? 'Hiba a bejegyzés mentésekor')
    } finally {
      setSubmitting(false)
    }
  }

  if (entries === undefined && !fetchError) {
    return (
      <div data-testid="journal-loading" className="space-y-3">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-14 w-full rounded-xl" />
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

  return (
    <div className="space-y-5">
      {/* Write form */}
      <form onSubmit={handleSubmit} className="surface-card rounded-xl border border-border p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Új bejegyzés</p>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Mi történt ma?"
          rows={3}
          className="w-full resize-none rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          disabled={submitting}
        />
        <div className="flex gap-2">
          <input
            type="text"
            value={mood}
            onChange={(e) => setMood(e.target.value)}
            placeholder="Hangulat (opcionális)"
            className="flex-1 rounded-lg border border-border bg-transparent px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
            disabled={submitting}
          />
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Tagek (opcionális)"
            className="flex-1 rounded-lg border border-border bg-transparent px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
            disabled={submitting}
          />
        </div>
        {postError && <p className="text-sm text-status-error">Hiba: {postError}</p>}
        <button
          type="submit"
          disabled={!content.trim() || submitting}
          className={cn(
            'w-full rounded-lg px-4 py-2 text-sm font-medium transition-colors',
            content.trim() && !submitting
              ? 'bg-primary text-white hover:bg-primary/90'
              : 'cursor-not-allowed bg-surface-alt text-text-muted',
          )}
        >
          {submitting ? 'Mentés...' : 'Bejegyzés'}
        </button>
      </form>

      {/* Entries list */}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Utolsó bejegyzések
        </p>
        {entries && entries.length === 0 ? (
          <p className="text-sm text-text-muted">Nincs bejegyzés még</p>
        ) : (
          <ul className="space-y-2">
            {(entries ?? []).map((entry) => (
              <EntryCard key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
