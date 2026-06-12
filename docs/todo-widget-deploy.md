# To-Do Widget — Deploy Notes (Genesis)

The To-Do widget (Claudia + Hibiki daily lists on the dashboard Overview page,
kanban card `c975228d`) is code-complete on branch `eng/todo-widget`. This file
lists the post-merge steps that are NOT part of the code change — the deploy/ops
actions that Genesis owns.

## 1. Rebuild + restart (src/ changed)

`src/db.ts`, `src/web.ts`, and `src/web/routes/todos.ts` are TypeScript, so the
dashboard server must be rebuilt and restarted (the `web/` static files are live
on refresh, but the API routes are not):

```bash
npm run build        # tsc
# then restart the dashboard/marveen process via the supervisor as usual
```

The `todo_items` table is created idempotently on boot by `initDatabase()` (same
`CREATE TABLE IF NOT EXISTS` pattern as `kanban_cards`); no manual migration.

## 2. Freshness write-heartbeat (FS-AC4)

Register an hourly task that runs the committed, deterministic checker:

```
schedule: "0 * * * *"   (hourly)
command:  python3 scripts/todo-freshness-check.py
```

It alerts `marveen` via inter-agent message when an owner (claudia/hibiki) has
not written to `todo_items` in > 26h, and self-suppresses repeat alerts for the
same ongoing outage (state file `store/.todo-freshness-state.json`). Dry-run to
verify without sending:

```bash
python3 scripts/todo-freshness-check.py --dry-run
```

## 3. Owner write-tasks (Claudia + Hibiki)

Each owner needs a daily task/heartbeat that POSTs its items via the fleet-ops
Bearer recipe (`POST /api/todos`, body via `python3 <<'PY'` heredoc — never
inline into `python3 -c`, never raw shell interpolation, WR-AC1):

- **Claudia** (`owner=claudia`): general `kind=task` items + learning
  `kind=progress` items (e.g. ISTQB), maintained daily; progress ticked via
  `POST /api/todos/:id/progress`.
- **Hibiki** (`owner=hibiki`, `section=fitness`): the daily training
  `kind=habit` item (`status` = done|skipped|rest) + calorie `kind=metric`
  item (`actual_val` / `target_val`), written once per day.

Server stamps all timestamps; agents send only
`title/detail/status/actual_val/target_val/progress_note/sort_order` (DM-AC2).

## 4. Sandbox first

Test the agent-write path on the Buster sandbox, never live Claudia/Hibiki, per
fleet policy.
