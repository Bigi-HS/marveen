import { usePolling } from '@/hooks/usePolling'
import { isAuthError } from '@/lib/auth-error'
import { ApiError } from '@/lib/api'
import { AuthRequired } from '@/components/AuthRequired'
import { Skeleton } from '@/components/Skeleton'
import { resetCountdown, clampPct, usageTone, type UsageState } from '@/lib/usage'

// Claude usage panel (card 7fe5662f). Reads GET /api/usage/current, which is
// credential-free by construction (only fiveHour/weekly % + reset ISO + stale).
// The panel lazy-renders on a 200; a 503 (feature-absent / auth-expired) shows a
// muted notice instead, so the page is safe before the credential is provisioned.

const TONE_TEXT: Record<'ok' | 'warn' | 'alert', string> = {
  ok: 'text-status-done',
  warn: 'text-status-waiting',
  alert: 'text-primary',
}
const TONE_BAR: Record<'ok' | 'warn' | 'alert', string> = {
  ok: 'bg-status-done',
  warn: 'bg-status-waiting',
  alert: 'bg-primary',
}

function UsageMeter({ label, pct, resetAt, nowMs }: { label: string; pct: number; resetAt: string; nowMs: number }) {
  const tone = usageTone(pct)
  const width = clampPct(pct)
  return (
    <div className="rounded-xl border border-border bg-bg-surface p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-medium text-text">{label}</span>
        <span className={`text-lg font-semibold tabular-nums ${TONE_TEXT[tone]}`}>{width}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-bg-elevated" role="progressbar" aria-valuenow={width} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`h-full rounded-full transition-all ${TONE_BAR[tone]}`} style={{ width: `${width}%` }} />
      </div>
      <p className="mt-2 text-xs text-text-muted">Resets {resetCountdown(resetAt, nowMs)}</p>
    </div>
  )
}

/** Muted notice for the non-200 states (feature-absent / auth-expired / degraded). */
function UsageNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-xl border border-border bg-bg-surface p-6 text-center">
      <h2 className="mb-2 text-base font-semibold text-text-muted">{title}</h2>
      <p className="text-sm text-text-muted">{body}</p>
    </div>
  )
}

export function UsagePage() {
  // Read-only poll. SSE does not carry usage, so this uses the plain 30s backstop
  // (the background refresher already only refetches claude.ai every 15 min).
  const usage = usePolling<UsageState>('/api/usage/current')

  if (isAuthError(usage.error)) return <AuthRequired />

  // A 503 from the endpoint is an EXPECTED feature-state, not an app error:
  // feature-absent (no credential) or auth-expired (session went stale). Distinguish
  // via the ApiError status; usePolling surfaces the non-2xx as an ApiError.
  if (usage.error instanceof ApiError && usage.error.status === 503) {
    return (
      <UsageNotice
        title="Claude usage unavailable"
        body="The usage panel is not provisioned yet, or the claude.ai session needs re-authentication. It stays hidden until a valid session is provided."
      />
    )
  }

  if (usage.loading && !usage.data) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    )
  }

  const data = usage.data
  if (!data) {
    return <UsageNotice title="Claude usage unavailable" body="No usage data available right now." />
  }

  const nowMs = Date.now()
  return (
    <div className="space-y-4">
      {data.stale && (
        <p className="rounded-lg border border-border bg-bg-surface px-3 py-2 text-xs text-text-muted">
          Showing the last known usage -- the live value could not be refreshed. Re-auth may be needed.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <UsageMeter label="5-hour window" pct={data.fiveHour.pct} resetAt={data.fiveHour.resetAt} nowMs={nowMs} />
        <UsageMeter label="Weekly window" pct={data.weekly.pct} resetAt={data.weekly.resetAt} nowMs={nowMs} />
      </div>
    </div>
  )
}
