/** Shown when no token is configured or the backend returns 401 (section 7). */
export function AuthRequired() {
  return (
    <div className="mx-auto mt-20 max-w-md rounded-lg border border-border bg-bg-surface p-6 text-center">
      <h2 className="mb-2 text-lg font-semibold text-primary">Hitelesítés szükséges</h2>
      <p className="text-sm text-text-muted">
        Nincs érvényes dashboard token. Állítsd be a <code className="text-accent">VITE_DASHBOARD_TOKEN</code>-t
        build-időben, vagy tedd a tokent a <code className="text-accent">localStorage["noa-api-token"]</code> kulcs
        alá, majd tölts újra.
      </p>
    </div>
  )
}
