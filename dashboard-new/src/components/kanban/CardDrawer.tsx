/**
 * Read-only card detail drawer -- Jira-issue-style full metadata view (DASH-034, 27f06e6c).
 * Schema-pending fields (blocked-on, work-time, status-history) are noted as coming soon.
 */
import { useEffect } from 'react'
import { X, Clock, Calendar, User, Tag, Hash } from 'lucide-react'
import { PriorityBadge } from '../PriorityBadge'
import { KANBAN_COLUMN_LABEL } from '@/lib/status'
import { agentDisplayName } from '@/lib/display-name'
import { cardAgeSeconds, formatAge } from '@/lib/kanban'
import { cn } from '@/lib/cn'
import type { KanbanCard, KanbanStatus } from '@/types/api'

function fmtDateTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
}

function fmtDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString('hu-HU', { timeZone: 'Europe/Budapest' })
}

function statusLabel(status: KanbanCard['status']): string {
  return status === 'someday' ? 'Valamikor' : (KANBAN_COLUMN_LABEL[status as KanbanStatus] ?? status)
}

function statusRing(status: KanbanCard['status']): string {
  switch (status) {
    case 'in_progress': return 'bg-blue-500/15 text-blue-400 ring-blue-500/30'
    case 'waiting': return 'bg-orange-500/15 text-orange-400 ring-orange-500/30'
    case 'done': return 'bg-green-500/15 text-green-400 ring-green-500/30'
    default: return 'bg-bg-elevated text-text-muted ring-border'
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">{title}</h3>
      <div className="divide-y divide-border/40 rounded-lg border border-border bg-bg-elevated">
        {children}
      </div>
    </section>
  )
}

function Row({ icon, label, children }: { icon?: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2">
      {icon && <span className="mt-0.5 shrink-0 text-text-muted">{icon}</span>}
      <span className="w-28 shrink-0 text-xs text-text-muted">{label}</span>
      <span className="text-xs text-text">{children}</span>
    </div>
  )
}

/**
 * Read-only card detail drawer (AC-F0-9, DASH-034). Jira-inspired layout.
 * Contains NO edit or action controls (INV-2 / AC-G2).
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

  const nowSec = Math.floor(Date.now() / 1000)
  const ageSec = cardAgeSeconds(card, nowSec)
  const ageLabel = formatAge(ageSec)
  const isActive = ['planned', 'in_progress', 'waiting'].includes(card.status)
  const isOverdue = card.due_date != null && card.due_date < nowSec && card.status !== 'done'

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Kártya részletei">
      <div className="absolute inset-0 bg-bg-deep/70" onClick={onClose} aria-hidden="true" />
      <aside className="relative flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-border bg-bg-surface shadow-xl">

        {/* Sticky header */}
        <div className="sticky top-0 z-10 border-b border-border bg-bg-surface px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            aria-label="Bezárás"
            className="absolute right-4 top-4 text-text-muted hover:text-text focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <X className="h-5 w-5" />
          </button>

          {/* Code + status + age chips */}
          <div className="flex flex-wrap items-center gap-2 pr-8">
            {card.code && (
              <span className="font-mono text-[11px] text-text-muted">{card.code}</span>
            )}
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset', statusRing(card.status))}>
              {statusLabel(card.status)}
            </span>
            {isActive && ageSec !== null && (
              <span className="flex items-center gap-1 text-[10px] text-text-muted">
                <Clock className="h-3 w-3" />
                {ageLabel}
              </span>
            )}
            {isOverdue && (
              <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400 ring-1 ring-inset ring-red-500/30">
                Lejarva
              </span>
            )}
          </div>

          <h2 className="mt-2 text-base font-semibold leading-snug text-text">{card.title}</h2>
        </div>

        <div className="flex-1 px-5 py-4">
          {/* Key metadata */}
          <Section title="Alap adatok">
            <Row icon={<User className="h-3.5 w-3.5" />} label="Felelős">
              {agentDisplayName(card.assignee) ?? 'Kiosztatlan'}
            </Row>
            <Row icon={<Tag className="h-3.5 w-3.5" />} label="Projekt">
              {card.project ?? '-'}
            </Row>
            <Row label="Prioritás">
              <PriorityBadge priority={card.priority} />
            </Row>
            {card.priority_score != null && (
              <Row label="P-score">
                {card.priority_score}/10
              </Row>
            )}
            {card.parent_id && (
              <Row icon={<Hash className="h-3.5 w-3.5" />} label="Szulo kártya">
                <span className="font-mono">{card.parent_id.slice(0, 8)}</span>
              </Row>
            )}
          </Section>

          {/* Description */}
          {card.description && (
            <section className="mb-5">
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Leírás</h3>
              <p className="whitespace-pre-wrap rounded-lg border border-border bg-bg-elevated p-3 text-xs leading-relaxed text-text">
                {card.description}
              </p>
            </section>
          )}

          {/* Timeline */}
          <Section title="Idovonal">
            <Row icon={<Calendar className="h-3.5 w-3.5" />} label="Létrehozva">
              {fmtDateTime(card.created_at)}
            </Row>
            {card.last_moved != null ? (
              <Row icon={<Clock className="h-3.5 w-3.5" />} label="Utolso mozgas">
                {fmtDateTime(card.last_moved)}
              </Row>
            ) : (
              <Row icon={<Clock className="h-3.5 w-3.5" />} label="Módosítva">
                {fmtDateTime(card.updated_at)}
              </Row>
            )}
            {card.dispatched_at != null && (
              <Row label="Kiszignálva">
                {fmtDateTime(card.dispatched_at)}
              </Row>
            )}
            {card.due_date != null && (
              <Row icon={<Calendar className="h-3.5 w-3.5" />} label="Határidő">
                <span className={cn(isOverdue ? 'font-semibold text-red-400' : 'text-text')}>
                  {fmtDate(card.due_date)}
                </span>
              </Row>
            )}
          </Section>

          {/* Technical reference */}
          <Section title="Referencia">
            <Row label="Kártya ID">
              <span className="break-all font-mono text-[10px]">{card.id}</span>
            </Row>
          </Section>

          {/* Schema-pending: upcoming fields */}
          <section className="mb-5">
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">Hamarosan</h3>
            <p className="rounded-lg border border-dashed border-border p-3 text-[10px] leading-relaxed text-text-muted">
              Blocked-on / waiting-on, munkaido-naplo es statusz-tortenet hamarosan --
              uj schema-mezok egyeztetes alatt (DASH-034 iteracio 2).
            </p>
          </section>
        </div>
      </aside>
    </div>
  )
}
