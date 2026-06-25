/** Shown when no token is configured or the backend returns 401 (section 7). */
export function AuthRequired() {
  return (
    <div className="mx-auto mt-20 max-w-md rounded-lg border border-border bg-bg-surface p-6 text-center">
      <h2 className="mb-2 text-lg font-semibold text-primary">Authentication required</h2>
      <p className="text-sm text-text-muted">
        No valid dashboard token. Set <code className="text-accent">VITE_DASHBOARD_TOKEN</code> at build time, or
        store a token in <code className="text-accent">localStorage["noa-api-token"]</code>, then reload.
      </p>
    </div>
  )
}
