#!/usr/bin/env bash
# deploy-build-frontend.sh -- build the dashboard-new (/v2 SPA) frontend into its
# SERVED dist location (card 6b977440).
#
# WHY THIS EXISTS: the dashboard server serves the Vite SPA from
# PROJECT_ROOT/dashboard-new/dist, read per-request (src/web.ts
# DASHBOARD_NEW_DIST + routes/dashboard-new.ts). The root `npm run build` only
# compiles the BACKEND (tsc -> dist/index.js); it never builds dashboard-new
# (separate package.json, `tsc -b && vite build`, gitignored dist). So before
# this step deploy.sh shipped a STALE /v2 frontend after every deploy (incident
# 2026-11-12). This function is factored out of deploy.sh so the build path is
# unit-testable with a stubbed npm (see __tests__/deploy-build-frontend.test.sh).
#
# Usage (sourced by deploy.sh, or run directly):
#   build_dashboard_new <repo> [wt_path] [isolated]
#     repo     : the live repo root (the SERVED dashboard-new/dist lives here)
#     wt_path  : isolated-build worktree path (required when isolated=1)
#     isolated : 1 = build in the worktree (target ref) and rsync into the served
#                repo dist; 0 (default) = build in place in repo/dashboard-new.
#   exit 0 ok | 1 build/assert failure | 2 usage error

set -uo pipefail

build_dashboard_new() {
  local repo="${1:-}" wt_path="${2:-}" isolated="${3:-0}"
  if [ -z "$repo" ]; then
    echo "build_dashboard_new: repo path required" >&2
    return 2
  fi
  local served_dist="$repo/dashboard-new/dist"

  if [ "$isolated" = "1" ]; then
    if [ -z "$wt_path" ]; then
      echo "build_dashboard_new: isolated mode needs a worktree path" >&2
      return 2
    fi
    # The worktree is a fresh checkout of the target ref: it has dashboard-new/src
    # but no node_modules (gitignored). Share the repo's installed deps so the
    # build does not need a second npm install.
    ln -sfn "$repo/dashboard-new/node_modules" "$wt_path/dashboard-new/node_modules"
    ( cd "$wt_path/dashboard-new" && npm run build ) \
      || { echo "build_dashboard_new: npm run build failed in worktree" >&2; return 1; }
    if [ ! -f "$wt_path/dashboard-new/dist/index.html" ]; then
      echo "build_dashboard_new: worktree dashboard-new/dist/index.html missing after build" >&2
      return 1
    fi
    # The server reads the REPO dist, never the worktree -- rsync it across
    # (mirrors deploy.sh step 6 for the backend dist).
    rsync -a --delete "$wt_path/dashboard-new/dist/" "$served_dist/" \
      || { echo "build_dashboard_new: rsync worktree dist -> served dist failed" >&2; return 1; }
  else
    ( cd "$repo/dashboard-new" && npm run build ) \
      || { echo "build_dashboard_new: npm run build failed" >&2; return 1; }
  fi

  # Served-dist assertion: a build that exits 0 but leaves no index.html is a
  # false green (the /v2 entry would 404 / stay stale). Fail hard.
  if [ ! -f "$served_dist/index.html" ]; then
    echo "build_dashboard_new: served $served_dist/index.html missing after build" >&2
    return 1
  fi
  return 0
}

# Dual-mode: sourced for tests (BASH_SOURCE != $0), executed when run directly.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  build_dashboard_new "$@"
fi
