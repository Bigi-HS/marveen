#!/usr/bin/env python3
"""memory-lint.py -- deterministic markdown memory-vault linter (fleet-meeting item A).

Layer 1 of the memory-lint compile pass: a zero-token, rule-based health check over
the markdown memory vault. It only ever FLAGS/SUGGESTS -- it never edits, deletes, or
merges anything (never-delete + reproducibility invariant). The optional qwen3:4b
SUGGEST-only layer (contradiction / merge proposals) is a separate follow-up.

Checks:
  (a) stale         -- an entry whose effective date is older than STALE_DAYS. The
                       effective date is the frontmatter `date:` if present, else the
                       file mtime. The index file is exempt (it is rewritten constantly).
  (b) oversized     -- an entry with more than MAX_LINES lines; the index file over
                       INDEX_MAX_BYTES; any index line longer than MAX_LINE_CHARS.
  (c) duplicate_slug-- two files sharing the same frontmatter `name:` slug.
  (d) dangling_links-- a [[slug]] with no matching file. A slug matches by filename
                       stem OR by frontmatter `name:`. Per the vault convention a
                       dangling link is an intentional forward-reference, not an error,
                       so it is reported but VERDICT-NEUTRAL unless MEMORY_LINT_STRICT_LINKS=1.

Output:
  - default: a human-readable report to stdout + a shields.io badge JSON to MEMORY_LINT_BADGE.
  - --json : the full structured report as JSON to stdout (badge still written).

Verdict: PASS (no actionable findings) or WARN (>=1 actionable finding). Never BLOCK --
this is advisory and must not gate anything. Exit 0 on PASS, 1 on WARN.

Env overrides (defaults target the live marveen vault + repo store/):
  MEMORY_LINT_DIR, MEMORY_LINT_BADGE, MEMORY_LINT_INDEX_NAME,
  MEMORY_LINT_STALE_DAYS, MEMORY_LINT_MAX_LINES, MEMORY_LINT_INDEX_MAX_BYTES,
  MEMORY_LINT_MAX_LINE_CHARS, MEMORY_LINT_STRICT_LINKS, MEMORY_LINT_NOW (epoch, for tests).
"""
import datetime as _dt
import json
import os
import re
import sys
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

DEFAULT_DIR = os.path.expanduser("~/.claude/projects/-home-domin-marveen/memory")
INDEX_NAME = os.environ.get("MEMORY_LINT_INDEX_NAME", "MEMORY.md")
STALE_DAYS = int(os.environ.get("MEMORY_LINT_STALE_DAYS", "90"))
MAX_LINES = int(os.environ.get("MEMORY_LINT_MAX_LINES", "50"))
# 24.4 KiB -- matches the vault's own overflow warning ("26KB" reported for a 27290-byte file).
INDEX_MAX_BYTES = int(os.environ.get("MEMORY_LINT_INDEX_MAX_BYTES", str(int(24.4 * 1024))))
MAX_LINE_CHARS = int(os.environ.get("MEMORY_LINT_MAX_LINE_CHARS", "200"))
STRICT_LINKS = os.environ.get("MEMORY_LINT_STRICT_LINKS", "") not in ("", "0", "false")

_WIKILINK = re.compile(r"\[\[([^\]\|]+?)(?:\|[^\]]*)?\]\]")


def _now():
    override = os.environ.get("MEMORY_LINT_NOW")
    return float(override) if override else time.time()


def _parse_frontmatter(text):
    """Return (name, date_str) from a leading `--- ... ---` YAML-ish block.

    Deliberately minimal: top-level `name:` and `date:` only -- no YAML dependency,
    so the result is reproducible and dependency-free.
    """
    name = None
    date_str = None
    if not text.startswith("---"):
        return name, date_str
    lines = text.split("\n")
    for line in lines[1:]:
        if line.strip() == "---":
            break
        m = re.match(r"^([A-Za-z_]+):\s*(.*)$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if key == "name" and name is None:
            name = val
        elif key == "date" and date_str is None:
            date_str = val
    return name, date_str


def _date_to_epoch(date_str):
    """Parse an ISO-ish `date:` value to epoch seconds, or None if unparseable."""
    if not date_str:
        return None
    s = date_str.strip().strip('"').strip("'")
    candidate = s.split("T")[0] if "T" in s else s[:10]
    try:
        d = _dt.date.fromisoformat(candidate)
    except ValueError:
        return None
    return time.mktime(_dt.datetime(d.year, d.month, d.day).timetuple())


def _load(memory_dir):
    """Read every *.md file once. Returns a list of dicts with parsed metadata."""
    entries = []
    for fn in sorted(os.listdir(memory_dir)):
        if not fn.endswith(".md"):
            continue
        path = os.path.join(memory_dir, fn)
        if not os.path.isfile(path):
            continue
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        name, date_str = _parse_frontmatter(text)
        entries.append({
            "file": fn,
            "stem": fn[:-3],          # filename without .md
            "name": name,
            "date_str": date_str,
            "text": text,
            "lines": text.count("\n") + (0 if text.endswith("\n") or not text else 1),
            "mtime": os.stat(path).st_mtime,
            "is_index": fn == INDEX_NAME,
        })
    return entries


def lint(memory_dir, now=None):
    """Run all checks. Returns the structured report dict. Read-only -- no mutation."""
    now = _now() if now is None else now
    entries = _load(memory_dir)

    stale, oversized, duplicate_slug, dangling = [], [], [], []

    # known slugs for link resolution: filename stems + frontmatter names
    known = set()
    by_name = {}
    for e in entries:
        known.add(e["stem"])
        if e["name"]:
            known.add(e["name"])
            by_name.setdefault(e["name"], []).append(e["file"])

    # (c) duplicate frontmatter name slugs
    for slug, files in sorted(by_name.items()):
        if len(files) > 1:
            duplicate_slug.append({"slug": slug, "files": sorted(files)})

    for e in entries:
        # (a) stale -- index exempt (it is rewritten on every memory change)
        if not e["is_index"]:
            fm_epoch = _date_to_epoch(e["date_str"])
            basis = "frontmatter" if fm_epoch is not None else "mtime"
            eff = fm_epoch if fm_epoch is not None else e["mtime"]
            age_days = int((now - eff) // 86400)
            if age_days > STALE_DAYS:
                stale.append({"file": e["file"], "age_days": age_days, "basis": basis})

        # (b) oversized
        if e["is_index"]:
            nbytes = len(e["text"].encode("utf-8"))
            if nbytes > INDEX_MAX_BYTES:
                oversized.append({"file": e["file"], "kind": "index_bytes",
                                  "bytes": nbytes, "limit": INDEX_MAX_BYTES})
            for i, line in enumerate(e["text"].split("\n"), 1):
                if len(line) > MAX_LINE_CHARS:
                    oversized.append({"file": e["file"], "kind": "index_line",
                                      "line": i, "chars": len(line), "limit": MAX_LINE_CHARS})
        else:
            if e["lines"] > MAX_LINES:
                oversized.append({"file": e["file"], "kind": "entry_lines",
                                  "lines": e["lines"], "limit": MAX_LINES})

        # (d) dangling links
        for m in _WIKILINK.finditer(e["text"]):
            target = m.group(1).strip()
            if target and target not in known:
                dangling.append({"file": e["file"], "link": target})

    counts = {
        "stale": len(stale),
        "oversized": len(oversized),
        "duplicate_slug": len(duplicate_slug),
        "dangling_links": len(dangling),
    }
    # Dangling links are advisory by default (intentional forward-refs); STRICT promotes them.
    actionable = counts["stale"] + counts["oversized"] + counts["duplicate_slug"]
    if STRICT_LINKS:
        actionable += counts["dangling_links"]
    verdict = "WARN" if actionable > 0 else "PASS"

    ts = int(now)
    return {
        "timestamp": ts,
        "timestamp_iso": _dt.datetime.fromtimestamp(ts).isoformat(timespec="seconds"),
        "verdict": verdict,
        "memory_dir": memory_dir,
        "files_scanned": len(entries),
        "thresholds": {
            "stale_days": STALE_DAYS, "max_lines": MAX_LINES,
            "index_max_bytes": INDEX_MAX_BYTES, "max_line_chars": MAX_LINE_CHARS,
            "strict_links": STRICT_LINKS,
        },
        "findings": {
            "stale": stale,
            "oversized": oversized,
            "duplicate_slug": duplicate_slug,
            "dangling_links": dangling,
        },
        "counts": counts,
        "actionable": actionable,
    }


def make_badge(report):
    """shields.io endpoint badge, mirroring the skill-regression badge convention."""
    c = report["counts"]
    if report["verdict"] == "PASS":
        msg = "clean" if c["dangling_links"] == 0 else f"clean ({c['dangling_links']} forward-refs)"
        color = "brightgreen"
    else:
        parts = [f"{c[k]} {k}" for k in ("stale", "oversized", "duplicate_slug") if c[k]]
        if STRICT_LINKS and c["dangling_links"]:
            parts.append(f"{c['dangling_links']} dangling_links")
        msg = f"{report['actionable']} flags: " + ", ".join(parts)
        color = "yellow"
    return {
        "schemaVersion": 1,
        "label": "memory-lint",
        "message": msg,
        "color": color,
        "verdict": report["verdict"],
        "counts": c,
        "actionable": report["actionable"],
        "total_files": report["files_scanned"],
        "timestamp": report["timestamp"],
        "timestamp_iso": report["timestamp_iso"],
    }


def _write_badge(report, badge_path):
    try:
        os.makedirs(os.path.dirname(badge_path), exist_ok=True)
        with open(badge_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(make_badge(report), indent=2))
    except OSError as e:
        print(f"[WARN] could not write badge {badge_path}: {e}", file=sys.stderr)


def _print_human(report):
    c = report["counts"]
    print(f"MEMORY-LINT: {report['verdict']} "
          f"({report['actionable']} actionable, {report['files_scanned']} files)")
    f = report["findings"]
    for item in f["stale"]:
        print(f"  stale     {item['file']} ({item['age_days']}d, {item['basis']})")
    for item in f["oversized"]:
        if item["kind"] == "index_bytes":
            print(f"  oversized {item['file']} index {item['bytes']}B > {item['limit']}B")
        elif item["kind"] == "index_line":
            print(f"  oversized {item['file']}:{item['line']} line {item['chars']} > {item['limit']} chars")
        else:
            print(f"  oversized {item['file']} {item['lines']} > {item['limit']} lines")
    for item in f["duplicate_slug"]:
        print(f"  dup-slug  '{item['slug']}' -> {', '.join(item['files'])}")
    note = "" if STRICT_LINKS else " (advisory; intentional forward-refs OK)"
    for item in f["dangling_links"]:
        print(f"  dangling  {item['file']} -> [[{item['link']}]]{note}")


def main(argv):
    as_json = "--json" in argv
    memory_dir = os.environ.get("MEMORY_LINT_DIR", DEFAULT_DIR)
    badge_path = os.environ.get("MEMORY_LINT_BADGE", os.path.join(REPO, "store", "memory-lint-badge.json"))

    if not os.path.isdir(memory_dir):
        print(f"[ERROR] memory dir not found: {memory_dir}", file=sys.stderr)
        return 2

    report = lint(memory_dir)
    _write_badge(report, badge_path)

    if as_json:
        print(json.dumps(report, indent=2))
    else:
        _print_human(report)

    return 1 if report["verdict"] == "WARN" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
