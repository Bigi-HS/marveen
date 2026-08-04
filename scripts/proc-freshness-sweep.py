#!/usr/bin/env python3
"""Report which running bash processes execute code that no longer matches disk.

Usage: proc-freshness-sweep.py <root>

Scans /proc for processes holding an fd 255 (the handle bash keeps open on the
script file it is executing) that resolves to a *.sh file under <root>, and
classifies each one:

  STALE    the content the process is running differs from the file on disk, or
           the script is gone entirely -- any deployed change to it is INERT
  UNKNOWN  the running content could not be read (permissions, exotic exec) --
           reported separately because "cannot tell" must never read as "fine"
  SUSPECT  content matches now, but the file was modified after the process
           started, so the version bash actually parsed cannot be established
           from outside
  (fresh)  content matches and the file has not changed since the process began

Output is TSV, one line per non-fresh process, then a COUNT line:
  <LABEL>\t<pid>\t<script>\t<why>\t<start epoch, or empty if unreadable>
  COUNT\t<stale>\t<unknown>\t<suspect>\t<fresh>\t<fleet-supervisor count>

The start epoch lets a caller separate a pre-existing backlog of stale processes
from one that went stale after a given instant. It is the last column so that
adding it cannot shift the meaning of the earlier ones.

Scope: only processes owned by the same user are visible -- readlink on another
user's /proc/PID/fd/255 raises, and those processes are skipped silently. Every
repo shell currently runs as one user, so this is a stated limit rather than a
gap; it would need revisiting if the fleet ever ran split-UID.

Why fd 255 rather than matching cmdline with pgrep: a cmdline regex also matches
any shell whose command line merely mentions the script -- including the wrapper
running the check itself, which was a live false positive. fd 255 is held only by
the process actually executing the file.

Why content comparison rather than inode identity: inode identity is wrong in
both directions. A `git checkout` restoring a byte-identical file mints a new
inode (false STALE), while a truncate-and-rewrite keeps the inode (false fresh).
Reading /proc/PID/fd/255 works even once the inode is unlinked, so the running
bytes can be compared to the on-disk bytes directly -- which is the invariant
that actually matters.
"""

import glob
import os
import sys
import time

DELETED_SUFFIX = " (deleted)"

# Grace window for the "file modified after the process started" heuristic.
#
# Process start time is derived from /proc/PID/stat ticks plus a boot instant
# estimated as time.time() - uptime, which drifts by tens of milliseconds. A
# script written immediately before it is launched can therefore appear to have
# been modified a few ms "after" its own process started. Without a margin, a
# freshly created-and-launched script is misclassified SUSPECT -- observed in the
# regression test. Only edits comfortably after start are of interest here, so a
# couple of seconds of slack costs nothing and removes the false signal.
START_MTIME_GRACE_SECONDS = 2.0


def process_start_time(proc_dir, boot):
    """Wall-clock start time of the process, or None if it cannot be read."""
    try:
        stat = open(os.path.join(proc_dir, "stat")).read()
        # Field 22 (1-based) is starttime, in clock ticks since boot. Parse after
        # the last ')' so a comm containing spaces or parens cannot shift fields.
        fields = stat[stat.rindex(")") + 2:].split()
        return float(fields[19]) / os.sysconf("SC_CLK_TCK") + boot
    except (OSError, ValueError, IndexError):
        return None


def sweep(root):
    root = os.path.realpath(root).rstrip("/")
    with open("/proc/uptime") as fh:
        boot = time.time() - float(fh.read().split()[0])

    stale, unknown, suspect = [], [], []
    fresh = 0
    supervisors = 0

    for proc_dir in glob.glob("/proc/[0-9]*"):
        pid = os.path.basename(proc_dir)
        fd255 = os.path.join(proc_dir, "fd", "255")
        try:
            target = os.readlink(fd255)
        except OSError:
            continue

        deleted = target.endswith(DELETED_SUFFIX)
        path = target[: -len(DELETED_SUFFIX)] if deleted else target
        if not path.startswith(root + "/") or not path.endswith(".sh"):
            continue

        name = os.path.basename(path)
        if name == "fleet-supervisor.sh":
            supervisors += 1

        started = process_start_time(proc_dir, boot)

        if not os.path.exists(path):
            stale.append((pid, name, "script no longer exists on disk", started))
            continue

        try:
            with open(fd255, "rb") as fh:
                running = fh.read()
            with open(path, "rb") as fh:
                on_disk = fh.read()
        except OSError as exc:
            unknown.append((pid, name, "cannot read running script (%s)" % type(exc).__name__, started))
            continue

        if running != on_disk:
            stale.append((pid, name, "running content differs from disk", started))
            continue

        # An unreadable start time makes the "modified after start" question
        # unanswerable, so it goes to UNKNOWN rather than to the fresh count.
        # Counting it fresh would be the same fail-open this sweep exists to
        # close: "cannot tell" must not read as "fine" (thor N4).
        if started is None:
            unknown.append((pid, name, "content matches but process start time is unreadable", None))
        elif started + START_MTIME_GRACE_SECONDS < os.path.getmtime(path):
            suspect.append((pid, name, "file modified after process start; parsed version unverifiable", started))
        else:
            fresh += 1

    return stale, unknown, suspect, fresh, supervisors


def main():
    if len(sys.argv) != 2:
        print("usage: proc-freshness-sweep.py <root>", file=sys.stderr)
        return 2
    stale, unknown, suspect, fresh, supervisors = sweep(sys.argv[1])
    for bucket, label in ((stale, "STALE"), (unknown, "UNKNOWN"), (suspect, "SUSPECT")):
        for pid, name, why, started in bucket:
            print("%s\t%s\t%s\t%s\t%s"
                  % (label, pid, name, why, "" if started is None else "%.0f" % started))
    print("COUNT\t%d\t%d\t%d\t%d\t%d"
          % (len(stale), len(unknown), len(suspect), fresh, supervisors))
    return 0


if __name__ == "__main__":
    sys.exit(main())
