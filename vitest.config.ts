import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['json'],
      reportsDirectory: 'coverage',
    },
    // ALLOWLIST (root-cause fix for the recurring stray-dir glob class).
    // The real suite lives entirely under src/ (src/__tests__/** plus a few
    // co-located tests like src/web/routes/metrics.test.ts). Every runaway-
    // failure incident below came from a NEW out-of-tree dir that the denylist
    // didn't yet cover: .claude/worktrees, .worktrees, marveen-wt, dist-backup-*,
    // dist.backup-*, store/dist-backup-*, agents/**, and most recently an
    // un-gitignored deploy stray `dist-staged-mixed-*` (card 585da3ce: 276 stray
    // test copies -> 3420 vitest failures). Pinning `include` to src/** terminates
    // the entire class: any future stray tree outside src/ is ignored by default,
    // no new exclude entry required. The exclude list below is kept as defense-in-
    // depth but is now redundant for out-of-tree strays.
    include: ['src/**/*.test.{ts,tsx,mjs}'],
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
      // Repo-local git worktrees under .worktrees/ (created by `git worktree add
      // .worktrees/<card>`). These are full stale checkouts of this repo, so their
      // src/__tests__ copies get globbed here and run duplicate/divergent tests
      // against the shared codetree test DB -> 103 flaky failures in the full suite
      // (Thor gate side-finding #594/#595, 2026-08-30). The real suite lives in
      // src/__tests__ at the repo root, never under .worktrees/, so excluding the
      // whole subtree is safe. Both the top-level and any nested form are covered.
      // (card a2c69cd6)
      '.worktrees/**',
      '**/.worktrees/**',
      // Exclude deploy-time dist backups (store/dist-backup-YYYYMMDD-HHMMSS/):
      // the backup dir contains __tests__ which vitest would otherwise glob.
      'store/dist-backup-*/**',
      // Repo-ROOT deploy backups in both dash and dot forms
      // (dist-backup-YYYYMMDD-* and dist.backup-YYYYMMDD-*): each is a full tree
      // with its own src/__tests__ copy. A full `vitest run` (the buster CI
      // pre-gate sweep on open PRs) globbed these stale copies and re-ran them
      // -- including a live-infra-hitting test -- wedging the dashboard event
      // loop into a relaunch loop (2026-10-02 fleet-wedge incident, card 381d4123;
      // memory incident-dashboard-wedge-vitest-live-infra-1002). Mirrors the
      // store/ rule above for the repo root.
      'dist-backup-*/**',
      'dist.backup-*/**',
      // Per-agent working dirs vendor skill-pack stub test files under
      // agents/<name>/.claude-config/skills/.../*.test.mjs. They are untracked
      // stubs, not this repo's suite, and only appear after certain scaffolds,
      // so `vitest run` globs them into ~125 "No test suite found" file-collection
      // failures that hide the real signal (3634/0) and confuse reviewers. No real
      // src suite lives under agents/ (it's src/__tests__), so exclude the whole
      // subtree. (card 06b0e188; memory vitest-agents-glob-noise)
      'agents/**',
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
