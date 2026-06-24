import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type TabKey = 'home' | 'kanban' | 'brain'

interface TabDef {
  key: TabKey
  label: string
  enabled: boolean
}

const TABS: TabDef[] = [
  { key: 'home', label: 'Mission Control', enabled: true },
  { key: 'kanban', label: 'Kanban', enabled: true },
  { key: 'brain', label: 'Brain', enabled: false }, // F1
]

/** App chrome: header with the NoA avatar glow + a tab bar. Mobile-first. */
export function NavShell({
  active,
  onSelect,
  children,
}: {
  active: TabKey
  onSelect: (tab: TabKey) => void
  children: ReactNode
}) {
  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col px-3 py-3 sm:px-5">
      <header className="mb-4 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-glow ring-1 ring-accent">
          <img src="/api/marveen/avatar" alt="NoA" className="h-full w-full object-cover" />
        </span>
        <h1 className="text-base font-semibold text-text">
          NoA <span className="text-text-muted">Mission Control</span>
        </h1>
      </header>

      <nav className="mb-4 flex gap-1 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            disabled={!tab.enabled}
            onClick={() => tab.enabled && onSelect(tab.key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              active === tab.key
                ? 'border-primary text-text'
                : 'border-transparent text-text-muted hover:text-text',
              !tab.enabled && 'cursor-not-allowed opacity-40 hover:text-text-muted',
            )}
          >
            {tab.label}
            {!tab.enabled && <span className="ml-1 text-[10px] uppercase">soon</span>}
          </button>
        ))}
      </nav>

      <main className="flex-1">{children}</main>
    </div>
  )
}
