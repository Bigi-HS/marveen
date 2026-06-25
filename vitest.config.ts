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
    ],
  },
})
