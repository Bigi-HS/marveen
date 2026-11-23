# Boot persistence (WSL, no systemd) -- GAP G4

The Genesis fleet runs on WSL, which has **no systemd** (`pidof systemd` is empty;
there is no `systemctl --user`). Nothing in the OS auto-starts the fleet, keeps a
crashed dashboard alive, or resurrects a dead agent. That job is done entirely by
the fleet's own shell layer. This doc is the authoritative description of how the
fleet comes up and stays up across reboots, and how to verify the chain is wired
on a migrated box.

## The boot chain

```
WSL start
  -> /etc/wsl.conf  [boot] command        (root-owned, NOT git-tracked)
       command = su - domin -c '/home/domin/marveen/scripts/fleet-boot.sh'
  -> scripts/fleet-boot.sh                 (boot entrypoint, detaches)
  -> scripts/fleet-supervisor.sh           (always-on supervisor, holds an flock)
       |- launch_dashboard   -> :3420 server (src/web/serve.ts)
       |- channels.sh        -> marveen-channels tmux session
       |- ensure_medic_watchdog, per-agent watchdogs, health checks (~20)
```

- **`/etc/wsl.conf [boot]`** is the only autostart hook. WSL runs the `[boot]`
  command once at start, as root with a bare environment; the `su - domin -c`
  wrapper re-enters the user login shell so `HOME`/`PATH`/auth are correct.
- **`scripts/fleet-boot.sh`** waits a few seconds for loopback/networking, then
  `nohup`-launches the supervisor and returns immediately (never stalls boot).
- **`scripts/fleet-supervisor.sh`** is the real "start-all" engine and the
  reboot-less keep-alive: it holds an `flock` (so only one runs), and on every
  tick it (re)launches the dashboard, the channels session, Medic, and the
  per-agent watchdogs, and runs the health detectors. This loop is what replaces
  the dead OS cron / absent systemd.

## Manual start-all (no reboot)

To bring the whole fleet up by hand -- after a migration, after
`wsl --shutdown`, or any time the supervisor is not running:

```bash
scripts/start-fleet.sh
```

It is idempotent: if the supervisor already holds its flock, it reports and
exits 0 without spawning a second one. It is the human-run twin of the
`[boot]` hook (both just launch the supervisor).

## Verify the chain (run on the NEW box after migration)

```bash
scripts/verify-boot-persistence.sh
```

Checks, and prints exact remediation if any link is missing:

1. `fleet-boot.sh`, `fleet-supervisor.sh`, `start-fleet.sh` all present.
2. `/etc/wsl.conf` exists and its `[boot]` command references `fleet-boot.sh`.
3. (informational) whether the supervisor is running right now.

Exit 0 = fully wired; exit 1 = incomplete.

## Migration gotcha (why this matters)

A `git clone` carries the three scripts but **NOT** `/etc/wsl.conf` -- it is
root-owned and lives outside the repo. After a migration the fleet can look
"done" (agents launched by hand) while the autostart hook is silently absent, so
the fleet does **not** survive the first reboot of the new box and nothing
resurrects crashed agents. Always run `verify-boot-persistence.sh` on the new box
and install the hook if it reports MISS:

```bash
# /etc/wsl.conf  (needs root; create or append)
[boot]
command = su - <user> -c '/home/<user>/marveen/scripts/fleet-boot.sh'
# then, from Windows:  wsl --shutdown   (the [boot] command runs on next start)
```

Bring the supervisor up first after migration (it is the recovery path): launch
Medic via the supervisor so a break-glass channel exists even if the rest of the
boot fails (see `store/specs/migration-readiness-plan-1123.md` section 1.9).

## Scheduled-task reconcile (same gap)

Scheduled tasks have two sources of truth that must stay consistent across a
migration or tasks silently stop firing: the file dirs under
`~/.claude/scheduled-tasks/<id>/` (the task body) and the `scheduled_tasks` rows
in `store/noa.db` (desired state). Diff them with:

```bash
scripts/reconcile-scheduled-tasks.py          # human report
scripts/reconcile-scheduled-tasks.py --json   # machine-readable
```

The dir name equals the DB `scheduled_tasks.id` by construction, so the report
is a set-diff that surfaces three classes:

- **FILE-ORPHAN** -- dir on disk with no DB row (never fires; dead weight).
- **ROW-ORPHAN** -- a non-deleted DB row whose body dir is missing (broken task;
  on migration, a row was carried but its dir was not).
- **DELETED-ON-DISK** -- a `status='deleted'` tombstone row whose dir still
  exists (harmless; prune before a migration snapshot so counts are explainable).

The historical **"157 dirs vs 213 rows"** mismatch (OPEN QUESTION 2 in the
migration plan) decomposes cleanly: 213 rows = 155 active/paused + 58 deleted
tombstones; 157 dirs = 155 that match a live row + 2 file-orphans
(`marveen-planning-report`, `noa-nightpush-review-0730`). So the gap is the 58
deleted-tombstone rows (which never fire) plus 2 orphan dirs -- not missing task
bodies. Authoritative source for whether a task **fires** is the DB row; the dir
is the body it executes.
