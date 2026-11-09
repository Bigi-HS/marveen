import { useEffect, useState } from 'react'
import { fetchPushSettings, savePushSettings } from '@/lib/api-app'
import { Skeleton } from '@/components/Skeleton'
import type { PushSettings } from '@/lib/api-app'

const CATEGORIES: { key: keyof PushSettings; label: string; desc: string }[] = [
  { key: 'workout', label: 'Edzés emlékeztető', desc: 'Értesítés ha nem indult el az edzés' },
  { key: 'todo', label: 'Teendő emlékeztető', desc: 'Napi teendők és határidők' },
  { key: 'fleet', label: 'Flotta figyelmeztetés', desc: 'Ágens leállás, hiba vagy stall' },
  { key: 'journal', label: 'Napló prompt', desc: 'Napi napló bejegyzés emlékeztető' },
]

export function PushSettingsScreen() {
  const [settings, setSettings] = useState<PushSettings | undefined>(undefined)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    fetchPushSettings()
      .then((s) => setSettings(s))
      .catch((err) => setFetchError((err as Error).message ?? 'Ismeretlen hiba'))
  }, [])

  async function handleToggle(key: keyof PushSettings) {
    if (!settings) return
    const prev = settings[key]
    const next = !prev
    // optimistic update
    setSettings({ ...settings, [key]: next })
    setSaveError(null)
    try {
      const updated = await savePushSettings({ [key]: next })
      setSettings(updated)
    } catch (err) {
      // rollback
      setSettings({ ...settings, [key]: prev })
      setSaveError((err as Error).message ?? 'Mentési hiba')
    }
  }

  if (settings === undefined && fetchError === null) {
    return (
      <div data-testid="push-settings-loading" className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="rounded-xl border border-red-900/40 bg-red-950/20 p-4 text-sm text-red-400">
        Hiba: {fetchError}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
        Értesítési beállítások
      </p>

      {saveError && (
        <p className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-400">
          Mentési hiba: {saveError}
        </p>
      )}

      <div className="space-y-2">
        {CATEGORIES.map(({ key, label, desc }) => (
          <div
            key={key}
            className="surface-card flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-text">{label}</p>
              <p className="text-xs text-text-muted">{desc}</p>
            </div>
            <input
              type="checkbox"
              data-testid={`toggle-${key}`}
              checked={settings?.[key] ?? true}
              onChange={() => handleToggle(key)}
              className="h-5 w-5 shrink-0 cursor-pointer accent-accent"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
