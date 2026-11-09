import { useState } from 'react'
import { apiPost } from '@/lib/api-app'
import { getToken } from '@/lib/api'
import { isAuthError } from '@/lib/auth-error'

interface TokenResult {
  token: string
  expiresAt: string
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {
    /* clipboard may be unavailable in non-secure context */
  })
}

export function MobileSetup() {
  const [generated, setGenerated] = useState<TokenResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const hasToken = Boolean(getToken())

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await apiPost<{ token: string; expiresAt: string }>('/api/auth/app-token', {
        label: 'mobile-app',
      })
      setGenerated(res)
    } catch (err) {
      if (err instanceof Error && isAuthError(err)) {
        setError('Admin jogosultság szükséges a token generáláshoz.')
      } else {
        setError('Token generálás sikertelen. Próbáld újra.')
      }
    } finally {
      setGenerating(false)
    }
  }

  function handleCopy(text: string) {
    copyToClipboard(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const setupUrl = generated
    ? `${window.location.origin}/v2/#token=${generated.token}`
    : null

  return (
    <div className="space-y-6">
      <div className="surface-card rounded-xl border border-border p-5">
        <h2 className="font-semibold text-text">Mobil app csatlakoztatás</h2>
        <p className="mt-1 text-sm text-text-muted">
          Generálj egy 90 napos JWT tokent, majd nyisd meg a linket a Tauri appban.
        </p>

        {!hasToken && (
          <p className="mt-3 rounded-lg bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
            Nincs aktív munkamenet. Lépj be a dashboardra előbb.
          </p>
        )}

        <button
          type="button"
          disabled={generating || !hasToken}
          onClick={handleGenerate}
          className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {generating ? 'Generálás...' : 'Token generálása'}
        </button>

        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>

      {generated && setupUrl && (
        <div className="surface-card space-y-3 rounded-xl border border-border p-5">
          <p className="text-sm font-medium text-text">Setup link</p>
          <p className="text-xs text-text-muted">
            Érvényes: {new Date(generated.expiresAt).toLocaleDateString('hu-HU')}
          </p>
          <div className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2">
            <code className="flex-1 truncate text-xs text-text-muted">{setupUrl}</code>
            <button
              type="button"
              onClick={() => handleCopy(setupUrl)}
              className="shrink-0 text-xs text-primary hover:underline"
            >
              {copied ? 'Másolva!' : 'Másolás'}
            </button>
          </div>
          <p className="text-xs text-text-muted">
            Nyisd meg a Tauri appban Tailscale-en át:{' '}
            <code className="text-text">
              http://{'<tailscale-ip>'}:3420/v2/#token={'{TOKEN}'}
            </code>
          </p>
        </div>
      )}
    </div>
  )
}
