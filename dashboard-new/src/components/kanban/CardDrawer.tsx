import { useEffect } from 'react'
import { X } from 'lucide-react'
import { PriorityBadge } from '../PriorityBadge'
import { KANBAN_COLUMN_LABEL } from '@/lib/status'
import { agentDisplayName } from '@/lib/display-name'
import type { KanbanCard, KanbanStatus } from '@/types/api'

function fmt(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
}

function statusLabel(status: KanbanCard['status']): string {
  return status === 'someday' ? 'Valamikor' : KANBAN_COLUMN_LABEL[status as KanbanStatus]
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-text">{value}</dd>
    </div>
  )
}

/**
 * Read-only card detail drawer (AC-F0-9). Right-side sheet, Escape / backdrop to
 * close. Contains NO edit or action controls (INV-2 / AC-G2).
 */
export function CardDrawer({ card, onClose }: { card: KanbanCard | null; onClose: () => void }) {
  useEffect(() => {
    if (!card) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, onClose])

  if (!card) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Kártya részletei">
      <div className="absolute inset-0 bg-bg-deep/70" onClick={onClose} aria-hidden="true" />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-bg-surface p-5 shadow-xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="Bezárás"
          className="absolute right-4 top-4 text-text-muted hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <X className="h-5 w-5" />
        </button>

        <h2 className="mb-4 pr-8 text-lg font-semibold text-text">{card.title}</h2>

        <div className="mb-4 flex items-center gap-2">
          <PriorityBadge priority={card.priority} />
          <span className="rounded bg-bg-elevated px-2 py-0.5 text-xs text-text-muted">{statusLabel(card.status)}</span>
        </div>

        {card.description && (
          <p className="mb-4 whitespace-pre-wrap text-sm text-text-muted">{card.description}</p>
        )}

        <dl className="grid grid-cols-2 gap-3">
          <Field label="Felelős" value={agentDisplayName(card.assignee) ?? 'kiosztatlan'} />
          <Field label="Projekt" value={card.project ?? '-'} />
          <Field label="Létrehozva" value={fmt(card.created_at)} />
          <Field label="Frissítve" value={fmt(card.updated_at)} />
          <Field label="Kártya ID" value={card.id} />
          {card.seq != null && <Field label="#" value={String(card.seq)} />}
        </dl>
      </aside>
    </div>
  )
}
