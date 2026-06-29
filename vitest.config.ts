import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      // Default vitest excludes
      '**/node_modules/**',
      '**/dist/**',
      // Exclude Workflow sub-agent worktrees and ephemeral eng worktrees
      // to prevent test-file globbing into stale/leftover worktree copies.
      // These share the codetree-test-DB path and cause 32+ flaky failures
      // via concurrent SQLite writes when vitest picks them up.
      '**/.claude/worktrees/**',
      '**/marveen-wt/**',
      '/tmp/wt-*/**',
      // Exclude deploy-time dist backups (store/dist-backup-YYYYMMDD-HHMMSS/):
      // the backup dir contains __tests__ which vitest would otherwise glob.
      'store/dist-backup-*/**',
      // dashboard-new is a separate Vite project with its OWN vitest config
      // (jsdom + React Testing Library setup). This root runner is node-env, so
      // globbing its tests here runs them under the wrong environment (no jsdom
      // -> EventSource / localStorage / renderHook fail -- the source of the
      // long-standing "4 pre-existing dashboard-new env failures"). Run them via
      // `cd dashboard-new && npm test`. (card 513b8fd6 F1)
      'dashboard-new/**',
    ],
  },
})
