import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type TabKey = 'home' | 'kanban' | 'gate' | 'hooks' | 'usage' | 'brain'

interface TabDef {
  key: TabKey
  label: string
  enabled: boolean
}

const TABS: TabDef[] = [
  { key: 'home', label: 'Mission Control', enabled: true },
  { key: 'kanban', label: 'Kanban', enabled: true },
  { key: 'gate', label: 'Gate Board', enabled: true },
  { key: 'hooks', label: 'Hook Stream', enabled: true },
  { key: 'usage', label: 'Usage', enabled: true }, // card 7fe5662f (dormant until store/.claude-session)
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
      <header className="surface-card relative mb-5 flex items-center gap-4 overflow-hidden rounded-2xl border border-border px-5 py-4">
        {/* faint depth glow anchored to the avatar side */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-10 -top-10 h-40 w-40 rounded-full bg-accent/10 blur-3xl"
        />
        <span className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full shadow-glow ring-2 ring-accent">
          <img src="/api/marveen/avatar" alt="NoA" className="h-full w-full object-cover" />
        </span>
        <div className="relative min-w-0">
          <h1 className="text-lg font-semibold leading-tight text-text">
            NoA <span className="font-normal text-text-muted">Mission Control</span>
          </h1>
          <p className="truncate text-xs text-text-muted">Nyugodt vizet, tiszta irányt.</p>
        </div>
      </header>

      {/* One swipeable row on narrow screens: labels stay whole and the tab bar
          scrolls horizontally instead of wrapping into broken two-line tabs (390px). */}
      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-border [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            disabled={!tab.enabled}
            onClick={() => tab.enabled && onSelect(tab.key)}
            className={cn(
              '-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
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
