import { useState } from 'react'
import { apiPost } from '@/lib/api-app'
import { getToken, parseTokenInput, saveToken } from '@/lib/api'
import { isAuthError } from '@/lib/auth-error'
import { buildPairingUrl } from '@/lib/pairing'
import { PairingQR } from '@/components/PairingQR'

interface TokenResult {
  token: string
  expiresAt: string
}

interface MobileSetupProps {
  /** Called after a token is persisted via manual connect. Defaults to a full
   *  reload so already-mounted screens re-read the token. Injectable for tests. */
  onConnected?: () => void
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {
    /* clipboard may be unavailable in non-secure context */
  })
}

export function MobileSetup({ onConnected }: MobileSetupProps = {}) {
  const [generated, setGenerated] = useState<TokenResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [pasteValue, setPasteValue] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)

  const hasToken = Boolean(getToken())

  function handleConnect() {
    const token = parseTokenInput(pasteValue)
    if (!token) {
      setPasteError('Érvénytelen token vagy link.')
      return
    }
    setPasteError(null)
    saveToken(token)
    ;(onConnected ?? (() => window.location.reload()))()
  }

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
    ? buildPairingUrl(window.location.origin, generated.token)
    : null

  return (
    <div className="space-y-6">
      <div className="surface-card rounded-xl border border-border p-5">
        <h2 className="font-semibold text-text">Csatlakozás tokennel</h2>
        <p className="mt-1 text-sm text-text-muted">
          Illeszd be a setup linket vagy a tokent (a desktop dashboardon generáltat),
          és csatlakozz. Ez az első belépés az appban.
        </p>
        <textarea
          aria-label="Setup link vagy token"
          value={pasteValue}
          onChange={(e) => {
            setPasteValue(e.target.value)
            if (pasteError) setPasteError(null)
          }}
          rows={2}
          placeholder="https://bigi.tail1a5fa5.ts.net/v2/#token=..."
          className="mt-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text"
        />
        <button
          type="button"
          onClick={handleConnect}
          className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white"
        >
          Csatlakozás
        </button>
        {pasteError && <p className="mt-2 text-xs text-red-400">{pasteError}</p>}
      </div>

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
          <div className="flex flex-col items-center gap-2 py-1">
            <PairingQR url={setupUrl} />
            <p className="text-xs text-text-muted">Szkenneld be a telefonoddal</p>
          </div>
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
