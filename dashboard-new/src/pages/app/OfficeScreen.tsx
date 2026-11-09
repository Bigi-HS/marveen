import { useEffect, useRef, useState } from 'react'
import { fetchAgentActivity } from '@/lib/api-app'
import { useEventStream } from '@/hooks/useEventStream'
import { Skeleton } from '@/components/Skeleton'
import { cn } from '@/lib/cn'
import type { AgentActivity, AgentActivityLabel } from '@/lib/api-app'

const STATE_ICON: Record<AgentActivityLabel, string> = {
  working: '💻',
  idle: '☕',
  stopped: '💤',
  unknown: '❓',
  error: '⚠️',
}

const STATE_LABEL: Record<AgentActivityLabel, string> = {
  working: 'dolgozik',
  idle: 'készenlét',
  stopped: 'leállítva',
  unknown: 'ismeretlen',
  error: 'hiba',
}

function AgentDesk({ agent }: { agent: AgentActivity }) {
  const lastTail = agent.tail.length > 0 ? agent.tail[agent.tail.length - 1] : null
  return (
    <div
      data-testid={`office-agent-${agent.name}`}
      data-state={agent.state}
      className={cn(
        'surface-card flex flex-col gap-1.5 rounded-xl border p-3 transition-colors',
        agent.state === 'working' && 'border-accent/40 bg-accent/5',
        agent.state === 'idle' && 'border-border',
        agent.state === 'stopped' && 'border-border opacity-50',
        (agent.state === 'unknown' || agent.state === 'error') && 'border-yellow-800/40',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn('text-xl leading-none', agent.state === 'working' && 'animate-pulse')}
          aria-hidden
        >
          {STATE_ICON[agent.state]}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-medium', agent.state === 'stopped' ? 'text-text-muted' : 'text-text')}>
            {agent.isMain ? 'NoA' : agent.name.charAt(0).toUpperCase() + agent.name.slice(1)}
          </p>
          <p className="text-xs text-text-muted">{STATE_LABEL[agent.state]}</p>
        </div>
      </div>
      {lastTail && agent.state === 'working' && (
        <p className="truncate rounded bg-bg px-2 py-1 font-mono text-xs text-text-muted">
          {lastTail}
        </p>
      )}
    </div>
  )
}

const POLL_INTERVAL_MS = 10_000

export function OfficeScreen() {
  const { connected, revisions } = useEventStream()
  const [agents, setAgents] = useState<AgentActivity[] | undefined>(undefined)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const prevRevisionRef = useRef<number>(-1)

  useEffect(() => {
    let cancelled = false
    function load() {
      fetchAgentActivity()
        .then((data) => { if (!cancelled) { setAgents(data); setFetchError(null) } })
        .catch((err) => { if (!cancelled) { setFetchError((err as Error).message ?? 'Ismeretlen hiba'); setAgents([]) } })
    }
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  // SSE-driven refetch: when agent-status revision bumps, reload immediately
  useEffect(() => {
    const rev = revisions['agent-status']
    if (prevRevisionRef.current === -1) { prevRevisionRef.current = rev; return }
    if (rev === prevRevisionRef.current) return
    prevRevisionRef.current = rev
    fetchAgentActivity()
      .then((data) => { setAgents(data); setFetchError(null) })
      .catch(() => { /* keep last data */ })
  }, [revisions])

  const loading = agents === undefined && fetchError === null
  const workingCount = (agents ?? []).filter((a) => a.state === 'working').length

  if (loading) {
    return (
      <div data-testid="office-loading" className="space-y-4">
        <Skeleton className="h-6 w-40 rounded" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  if (fetchError && (agents === undefined || agents.length === 0)) {
    return (
      <div className="rounded-xl border border-red-900/40 bg-red-950/20 p-4 text-sm text-red-400">
        Hiba: {fetchError}
      </div>
    )
  }

  const list = agents ?? []

  if (list.length === 0) {
    return <p className="text-sm text-text-muted">Nincs aktív ágens.</p>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            data-testid={connected ? 'office-connected' : 'office-disconnected'}
            className={cn('h-2 w-2 rounded-full', connected ? 'bg-green-400' : 'bg-zinc-500')}
            title={connected ? 'Élő frissítés' : 'Polling (SSE offline)'}
          />
          <p className="text-xs text-text-muted">{connected ? 'Élő' : 'Polling'}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            data-testid="office-working-count"
            className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent"
          >
            {workingCount}
          </span>
          <span className="text-xs text-text-muted">dolgozik</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {list.map((agent) => (
          <AgentDesk key={agent.name} agent={agent} />
        ))}
      </div>
    </div>
  )
}
