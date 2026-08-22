#!/usr/bin/env python3
"""
Coverage trend tracker for the Genesis fleet.

Records per-PR coverage snapshots to SQLite and renders an SVG trend chart.

Usage:
  # Record a coverage snapshot from JSON summary:
  echo '{"total":{"lines":{"pct":84.2}},"src/web/dashboard-auth.ts":{"lines":{"pct":95.0}}}' \
    | ./coverage-trend.py record --pr 42 --branch feat/foo

  # Generate SVG trend chart (last 20 PRs):
  ./coverage-trend.py chart --out coverage-trend.svg

  # List recorded history:
  ./coverage-trend.py list

Input JSON format (from vitest/nyc/c8 coverage-summary.json):
  {
    "total": {"lines": {"pct": 84.2}, "statements": {"pct": 83.1}, ...},
    "<file>":  {"lines": {"pct": 72.0}, ...},
    ...
  }
"""

import argparse
import json
import math
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "coverage-history.db"


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def open_db(path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS coverage_snapshots (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            pr_number INTEGER,
            branch    TEXT,
            sha       TEXT,
            recorded_at INTEGER NOT NULL,
            total_pct REAL NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS coverage_files (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id INTEGER NOT NULL REFERENCES coverage_snapshots(id),
            file_path   TEXT NOT NULL,
            lines_pct   REAL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cf_snapshot ON coverage_files(snapshot_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cs_pr_number ON coverage_snapshots(pr_number)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cs_recorded_at ON coverage_snapshots(recorded_at)")
    conn.commit()
    return conn


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_record(args):
    # Validate that at least one identifying field is provided
    if not args.pr and not args.branch and not args.sha:
        print("ERROR: must provide at least one of: --pr, --branch, --sha", file=sys.stderr)
        sys.exit(1)
    raw = sys.stdin.read().strip()
    if not raw:
        print("ERROR: no JSON on stdin", file=sys.stderr)
        sys.exit(1)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"ERROR: invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    total_pct = None
    if "total" in data:
        total_pct = data["total"].get("lines", {}).get("pct") \
            or data["total"].get("statements", {}).get("pct")
    if total_pct is None:
        print("ERROR: could not find total.lines.pct or total.statements.pct in JSON", file=sys.stderr)
        sys.exit(1)

    conn = open_db(Path(args.db))
    cur = conn.execute(
        "INSERT INTO coverage_snapshots (pr_number, branch, sha, recorded_at, total_pct) VALUES (?,?,?,?,?)",
        (args.pr, args.branch, args.sha, int(datetime.now(timezone.utc).timestamp()), total_pct)
    )
    snap_id = cur.lastrowid

    for file_path, metrics in data.items():
        if file_path == "total":
            continue
        if not isinstance(metrics, dict):
            continue
        lines_pct = metrics.get("lines", {}).get("pct")
        conn.execute(
            "INSERT INTO coverage_files (snapshot_id, file_path, lines_pct) VALUES (?,?,?)",
            (snap_id, file_path, lines_pct)
        )
    conn.commit()
    conn.close()

    print(f"Recorded snapshot #{snap_id}: PR #{args.pr} branch={args.branch} total={total_pct:.1f}%")


def cmd_list(args):
    conn = open_db(Path(args.db))
    rows = conn.execute(
        "SELECT id, pr_number, branch, sha, recorded_at, total_pct FROM coverage_snapshots ORDER BY recorded_at DESC LIMIT ?",
        (args.limit,)
    ).fetchall()
    conn.close()

    if not rows:
        print("No snapshots recorded yet.")
        return

    print(f"{'ID':>4}  {'PR':>6}  {'Branch':<30}  {'Total%':>7}  {'Date'}")
    print("-" * 70)
    for r in rows:
        date = datetime.fromtimestamp(r["recorded_at"], tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
        pr = f"#{r['pr_number']}" if r["pr_number"] else "-"
        print(f"{r['id']:>4}  {pr:>6}  {(r['branch'] or '-'):<30}  {r['total_pct']:>6.1f}%  {date}")


def cmd_chart(args):
    conn = open_db(Path(args.db))
    rows = conn.execute(
        "SELECT id, pr_number, branch, recorded_at, total_pct FROM coverage_snapshots ORDER BY recorded_at ASC LIMIT ?",
        (args.last,)
    ).fetchall()

    if len(rows) < 2:
        print("Not enough snapshots to draw a trend (need >= 2).")
        conn.close()
        return

    # Optionally overlay worst-losing files between first and last snapshot
    first_id = rows[0]["id"]
    last_id  = rows[-1]["id"]

    first_files = {r["file_path"]: r["lines_pct"] for r in conn.execute(
        "SELECT file_path, lines_pct FROM coverage_files WHERE snapshot_id=?", (first_id,)
    ).fetchall() if r["lines_pct"] is not None}

    last_files = {r["file_path"]: r["lines_pct"] for r in conn.execute(
        "SELECT file_path, lines_pct FROM coverage_files WHERE snapshot_id=?", (last_id,)
    ).fetchall() if r["lines_pct"] is not None}

    conn.close()

    # Top losers (files that lost most coverage)
    deltas = []
    for fp in set(first_files) & set(last_files):
        delta = last_files[fp] - first_files[fp]
        if delta < 0:
            deltas.append((delta, fp))
    deltas.sort()
    top_losers = deltas[:5]

    # SVG
    W, H = 800, 360
    PAD_L, PAD_R, PAD_T, PAD_B = 60, 30, 30, 80
    chart_w = W - PAD_L - PAD_R
    chart_h = H - PAD_T - PAD_B

    values = [r["total_pct"] for r in rows]
    labels = [f"PR#{r['pr_number']}" if r["pr_number"] else f"#{r['id']}" for r in rows]

    min_v = max(0.0, min(values) - 5)
    max_v = min(100.0, max(values) + 5)
    span  = max_v - min_v or 1.0

    def px(i, v):
        x = PAD_L + (i / (len(rows) - 1)) * chart_w
        y = PAD_T + (1 - (v - min_v) / span) * chart_h
        return x, y

    # Build polyline points
    pts = [px(i, v) for i, v in enumerate(values)]
    polyline = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)

    # Color: green if trend is up, red if down
    trend_color = "#22c55e" if values[-1] >= values[0] else "#ef4444"

    lines_svg = []

    # Y grid lines
    for pct in range(math.ceil(min_v), math.floor(max_v) + 1, 5):
        _, gy = px(0, pct)
        lines_svg.append(
            f'<line x1="{PAD_L}" y1="{gy:.1f}" x2="{W - PAD_R}" y2="{gy:.1f}" '
            f'stroke="#e5e7eb" stroke-width="1"/>'
        )
        lines_svg.append(
            f'<text x="{PAD_L - 6}" y="{gy + 4:.1f}" text-anchor="end" '
            f'font-size="11" fill="#6b7280">{pct}%</text>'
        )

    # X labels (every label or thinned)
    step = max(1, len(rows) // 10)
    for i, (label, (x, _)) in enumerate(zip(labels, pts)):
        if i % step == 0 or i == len(rows) - 1:
            lines_svg.append(
                f'<text x="{x:.1f}" y="{H - PAD_B + 18}" text-anchor="middle" '
                f'font-size="10" fill="#6b7280">{label}</text>'
            )

    # Polyline
    lines_svg.append(
        f'<polyline points="{polyline}" fill="none" stroke="{trend_color}" '
        f'stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>'
    )

    # Dots
    for x, y in pts:
        lines_svg.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.5" fill="{trend_color}" stroke="white" stroke-width="1.5"/>'
        )

    # First/last annotation
    x0, y0 = pts[0]
    xn, yn = pts[-1]
    lines_svg.append(
        f'<text x="{x0:.1f}" y="{y0 - 8:.1f}" text-anchor="middle" font-size="11" '
        f'fill="{trend_color}" font-weight="bold">{values[0]:.1f}%</text>'
    )
    lines_svg.append(
        f'<text x="{xn:.1f}" y="{yn - 8:.1f}" text-anchor="middle" font-size="11" '
        f'fill="{trend_color}" font-weight="bold">{values[-1]:.1f}%</text>'
    )

    # Top losers legend
    legend_y = H - PAD_B + 38
    lines_svg.append(
        f'<text x="{PAD_L}" y="{legend_y}" font-size="11" fill="#374151" font-weight="bold">'
        f'Top losers (first → last):</text>'
    )
    for idx, (delta, fp) in enumerate(top_losers):
        short = fp if len(fp) <= 55 else "..." + fp[-52:]
        lines_svg.append(
            f'<text x="{PAD_L}" y="{legend_y + 14 + idx * 13}" font-size="10" fill="#ef4444">'
            f'{short}  ({delta:+.1f}pp)</text>'
        )

    svg = f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H + len(top_losers) * 13}">
  <rect width="{W}" height="{H + len(top_losers) * 13}" fill="white"/>
  <text x="{W // 2}" y="20" text-anchor="middle" font-size="14" fill="#111827" font-weight="bold">
    Coverage Trend (last {len(rows)} snapshots)
  </text>
  {''.join(lines_svg)}
</svg>"""

    out = Path(args.out)
    out.write_text(svg, encoding="utf-8")
    print(f"Chart written to {out} ({len(rows)} snapshots, {values[0]:.1f}% → {values[-1]:.1f}%)")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="Coverage trend tracker")
    p.add_argument("--db", default=str(DB_PATH), help="Path to SQLite database")
    sub = p.add_subparsers(dest="cmd")

    r = sub.add_parser("record", help="Record a coverage snapshot from stdin JSON")
    r.add_argument("--pr",     type=int, default=None, help="PR number")
    r.add_argument("--branch", default=None, help="Branch name")
    r.add_argument("--sha",    default=None, help="Commit SHA")

    sub.add_parser("list", help="List recorded snapshots").add_argument(
        "--limit", type=int, default=30
    )

    c = sub.add_parser("chart", help="Generate SVG trend chart")
    c.add_argument("--out",  default="coverage-trend.svg", help="Output SVG path")
    c.add_argument("--last", type=int, default=20, help="Max snapshots to plot")

    args = p.parse_args()
    if args.cmd == "record":
        cmd_record(args)
    elif args.cmd == "list":
        cmd_list(args)
    elif args.cmd == "chart":
        cmd_chart(args)
    else:
        p.print_help()


if __name__ == "__main__":
    main()
