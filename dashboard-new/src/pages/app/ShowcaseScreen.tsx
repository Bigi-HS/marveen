import { useEffect, useState } from 'react'
import { fetchShowcaseAgents, generateShowcaseShareToken } from '@/lib/api-app'
import { Skeleton } from '@/components/Skeleton'
import { cn } from '@/lib/cn'
import type { ShowcaseAgentItem, ShowcaseState } from '@/lib/api-app'

const STATE_ICON: Record<ShowcaseState, string> = {
  working: '💻',
  idle:    '☕',
  running: '🟢',
  stopped: '💤',
}

const STATE_LABEL: Record<ShowcaseState, string> = {
  working: 'dolgozik',
  idle:    'készenlét',
  running: 'fut',
  stopped: 'leállítva',
}

function AgentCard({ agent }: { agent: ShowcaseAgentItem }) {
  return (
    <div
      data-testid={`showcase-agent-${agent.roleLabel}`}
      data-state={agent.state}
      className={cn(
        'surface-card flex items-center gap-3 rounded-xl border p-3 transition-colors',
        agent.state === 'working' && 'border-accent/40 bg-accent/5',
        agent.state === 'idle'    && 'border-border',
        agent.state === 'running' && 'border-green-700/40 bg-green-900/5',
        agent.state === 'stopped' && 'border-border opacity-50',
      )}
    >
      <span
        className={cn('text-xl leading-none', agent.state === 'working' && 'animate-pulse')}
        aria-hidden
      >
        {STATE_ICON[agent.state]}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm font-medium', agent.state === 'stopped' ? 'text-text-muted' : 'text-text')}>
          {agent.roleLabel}
        </p>
        <p className="text-xs text-text-muted">{STATE_LABEL[agent.state]}</p>
      </div>
    </div>
  )
}

function SharePanel() {
  const [token, setToken] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const shareUrl = token
    ? `${window.location.origin}/v2/#token=${token}&view=showcase`
    : null

  const iframeCode = shareUrl
    ? `<iframe src="${shareUrl}" width="400" height="600" frameborder="0" title="NoA Fleet Showcase"></iframe>`
    : null

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const result = await generateShowcaseShareToken()
      setToken(result.token)
    } catch (err) {
      setError((err as Error).message ?? 'Generálási hiba')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="surface-card space-y-3 rounded-xl border border-border p-4">
      <p className="text-sm font-medium text-text">Publikus megosztás</p>
      <p className="text-xs text-text-muted">
        24 órás share-linket generálhatsz, amellyel a showcase nézet jelszó nélkül megtekinthető.
        Admin token szükséges.
      </p>
      <button
        data-testid="showcase-generate-btn"
        onClick={handleGenerate}
        disabled={generating}
        className={cn(
          'rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity',
          generating && 'cursor-not-allowed opacity-60',
        )}
      >
        {generating ? 'Generálás...' : 'Link generálása (24h)'}
      </button>

      {error && (
        <p data-testid="showcase-token-error" className="rounded-lg bg-red-900/20 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {shareUrl && (
        <div className="space-y-2">
          <div>
            <p className="mb-1 text-xs font-medium text-text-muted">Share URL</p>
            <code
              data-testid="showcase-share-url"
              className="block break-all rounded-lg bg-bg px-3 py-2 text-xs text-text"
            >
              {shareUrl}
            </code>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-text-muted">Embed iframe</p>
            <code
              data-testid="showcase-embed-code"
              className="block break-all rounded-lg bg-bg px-3 py-2 text-xs text-text"
            >
              {iframeCode}
            </code>
          </div>
        </div>
      )}
    </div>
  )
}

const POLL_INTERVAL_MS = 15_000

export function ShowcaseScreen() {
  const [agents, setAgents] = useState<ShowcaseAgentItem[] | undefined>(undefined)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    function load() {
      fetchShowcaseAgents()
        .then((data) => { if (!cancelled) { setAgents(data); setFetchError(null) } })
        .catch((err) => { if (!cancelled) { setFetchError((err as Error).message ?? 'Ismeretlen hiba'); setAgents([]) } })
    }
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  if (agents === undefined && fetchError === null) {
    return (
      <div data-testid="showcase-loading" className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    )
  }

  if (fetchError) {
    return (
      <div data-testid="showcase-error" className="rounded-xl border border-red-800/40 bg-red-900/10 p-4">
        <p className="text-sm text-red-400">{fetchError}</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div data-testid="showcase-grid" className="grid gap-2 sm:grid-cols-2">
        {(agents ?? []).map((a) => (
          <AgentCard key={a.roleLabel} agent={a} />
        ))}
        {(agents ?? []).length === 0 && (
          <p className="col-span-2 text-center text-sm text-text-muted">Nincs elérhető ágens.</p>
        )}
      </div>
      <SharePanel />
    </div>
  )
}
