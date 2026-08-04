#!/usr/bin/env python3
"""Report which running processes execute code that no longer matches disk.

Usage: proc-freshness-sweep.py <root>

Scans /proc for:
  (a) bash processes holding fd 255 (the handle bash keeps open on the script
      file it is executing) that resolves to a *.sh file under <root>
  (b) python3 processes whose cmdline names a *.py script under <root>

Each process is classified as:

  STALE    the content the process is running differs from the file on disk, or
           the script is gone entirely -- any deployed change to it is INERT
  UNKNOWN  the running content could not be determined -- "cannot tell" must
           never read as "fine"
  SUSPECT  content matches now (or mtime suggests no change), but the file was
           modified after the process started, so the version actually parsed
           cannot be established from outside
  (fresh)  content matches and the file has not changed since the process began
           (bash/content-verified only; python/mtime-heuristic processes are
           never counted as fresh because their content cannot be verified)

Output is TSV, one line per non-fresh process, then a COUNT line:
  <LABEL>\t<pid>\t<script>\t<why>\t<start epoch>\t<script mtime epoch>\t<method>
  COUNT\t<stale>\t<unknown>\t<suspect>\t<fresh>\t<fleet-supervisor count>
Columns 1-6 are unchanged from the original format. Column 7 (method) is new:
  content-verified   running bytes were compared to disk bytes (fd 255, reliable)
  mtime-heuristic    only file mtime vs process start could be checked (python)

Either epoch is empty when it cannot be read; a caller must treat empty as
"unknown", never as "old".

The argv of a process is NEVER written to the report. Only the interpreter name
(exe-name, e.g. "python3") and the script path appear; arguments following the
script name may contain credentials and are not needed for staleness analysis.

Staleness is a relation between a PROCESS and a FILE, so both timestamps are
reported. Start time alone cannot answer "was this divergence already known?" --
a long-lived process that predates any cutoff goes stale afresh the moment its
script is edited, and a caller keying only on start time would file that new
divergence under an old backlog. New columns are appended so that adding them
cannot shift the meaning of the earlier ones.

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

Why python processes are always UNKNOWN when mtime shows no change (not fresh):
Python closes the script file immediately after parsing it, so there is no open
fd to read the running bytecode from. Mtime <= start means "we saw no evidence
of change", not "content is guaranteed identical". Counting that as fresh would
be the same fail-open this sweep exists to prevent.
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


def _sweep_bash(root, boot, stale, unknown, suspect, supervisors_ref):
    """Classify bash processes via fd/255 content comparison (content-verified)."""
    fresh = 0
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
            supervisors_ref[0] += 1

        started = process_start_time(proc_dir, boot)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = None

        method = "content-verified"

        if not os.path.exists(path):
            stale.append((pid, name, "script no longer exists on disk", started, mtime, method))
            continue

        try:
            with open(fd255, "rb") as fh:
                running = fh.read()
            with open(path, "rb") as fh:
                on_disk = fh.read()
        except OSError as exc:
            unknown.append((pid, name, "cannot read running script (%s)" % type(exc).__name__, started, mtime, method))
            continue

        if running != on_disk:
            stale.append((pid, name, "running content differs from disk", started, mtime, method))
            continue

        # An unreadable start time makes the "modified after start" question
        # unanswerable, so it goes to UNKNOWN rather than to the fresh count.
        # Counting it fresh would be the same fail-open this sweep exists to
        # close: "cannot tell" must not read as "fine" (thor N4).
        if started is None or mtime is None:
            unknown.append((pid, name, "content matches but start time or file mtime is unreadable", started, mtime, method))
        elif started + START_MTIME_GRACE_SECONDS < mtime:
            suspect.append((pid, name, "file modified after process start; parsed version unverifiable", started, mtime, method))
        else:
            fresh += 1
    return fresh


def _sweep_python(root, boot, stale, unknown, suspect):
    """Classify python3 processes via cmdline + mtime-heuristic.

    Python closes its script file immediately after parsing, so content
    comparison via an open fd is not possible. The method is therefore
    mtime-heuristic: if the on-disk file was modified after the process started,
    flag SUSPECT; otherwise UNKNOWN (mtime shows no signal, but content cannot
    be verified -- must not count as fresh per OPS-103 constraint).

    Only the interpreter name and script path are examined. Argv beyond the
    script name is never read or reported (may contain credentials).
    """
    seen_pids = {str(os.getpid())}  # exclude the sweep process itself
    for proc_dir in glob.glob("/proc/[0-9]*"):
        pid = os.path.basename(proc_dir)
        cmdline_path = os.path.join(proc_dir, "cmdline")
        try:
            with open(cmdline_path, "rb") as fh:
                raw = fh.read()
        except OSError:
            continue

        # \x00-delimited argv; only exe and script path matter, skip the rest
        args = raw.rstrip(b"\x00").split(b"\x00")
        if not args:
            continue
        exe_bytes = args[0]
        exe_name = os.path.basename(exe_bytes.decode(errors="replace"))
        if not (exe_name.startswith("python3") or exe_name.startswith("python")):
            continue

        # Find the script argument: first arg ending in .py (skip flags starting
        # with -). Stop after finding it; never inspect args beyond it.
        script_path = None
        for arg in args[1:]:
            decoded = arg.decode(errors="replace")
            if not decoded or decoded.startswith("-"):
                continue
            if decoded.endswith(".py"):
                # Resolve absolute; skip relative paths that don't resolve under
                # root to avoid false-positives from system/venv python scripts.
                candidate = os.path.realpath(decoded)
                if candidate.startswith(root + "/"):
                    script_path = candidate
                break
            # Non-flag, non-.py argument before the script (e.g. -m) -- skip
        if script_path is None:
            continue
        if pid in seen_pids:
            continue
        seen_pids.add(pid)

        name = os.path.basename(script_path)
        method = "mtime-heuristic"
        started = process_start_time(proc_dir, boot)

        if not os.path.exists(script_path):
            mtime = None
            stale.append((pid, name, "script no longer exists on disk", started, mtime, method))
            continue

        try:
            mtime = os.path.getmtime(script_path)
        except OSError:
            mtime = None

        if started is None or mtime is None:
            unknown.append((pid, name,
                             "mtime-heuristic: start time or file mtime unreadable",
                             started, mtime, method))
        elif started + START_MTIME_GRACE_SECONDS < mtime:
            suspect.append((pid, name,
                             "mtime-heuristic: file modified after process start; running version unverifiable",
                             started, mtime, method))
        else:
            # mtime shows no staleness signal, but content cannot be verified --
            # must be UNKNOWN, not fresh (OPS-103: content-unverifiable != PASS)
            unknown.append((pid, name,
                             "mtime-heuristic: content comparison not possible for python; no mtime staleness signal",
                             started, mtime, method))


def sweep(root):
    root = os.path.realpath(root).rstrip("/")
    with open("/proc/uptime") as fh:
        boot = time.time() - float(fh.read().split()[0])

    stale, unknown, suspect = [], [], []
    supervisors_ref = [0]

    fresh = _sweep_bash(root, boot, stale, unknown, suspect, supervisors_ref)
    _sweep_python(root, boot, stale, unknown, suspect)

    return stale, unknown, suspect, fresh, supervisors_ref[0]


def main():
    if len(sys.argv) != 2:
        print("usage: proc-freshness-sweep.py <root>", file=sys.stderr)
        return 2
    stale, unknown, suspect, fresh, supervisors = sweep(sys.argv[1])
    for bucket, label in ((stale, "STALE"), (unknown, "UNKNOWN"), (suspect, "SUSPECT")):
        for pid, name, why, started, mtime, method in bucket:
            print("%s\t%s\t%s\t%s\t%s\t%s\t%s"
                  % (label, pid, name, why,
                     "" if started is None else "%.0f" % started,
                     "" if mtime is None else "%.0f" % mtime,
                     method))
    print("COUNT\t%d\t%d\t%d\t%d\t%d"
          % (len(stale), len(unknown), len(suspect), fresh, supervisors))
    return 0


if __name__ == "__main__":
    sys.exit(main())
