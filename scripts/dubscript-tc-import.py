#!/usr/bin/env python3
"""
dubscript-tc-import.py -- Merge faster-whisper SRT timestamps into dubbing script CSV.

Matches SRT segments to CSV rows by fuzzy EN text comparison, then writes
TC_IN / TC_OUT into the new 16-column template format.

Usage:
    python3 dubscript-tc-import.py \
        --csv store/dubscript-spaceking-ep1-sample.csv \
        --srt store/spaceking-ep1/spaceking-ep1-en.srt \
        --out store/spaceking-ep1/spaceking-ep1-template-v1.csv

Output CSV columns (per dubscript-template-v1.md):
    GLOBAL_ID, #, TC_IN, TC_OUT, DUR, KAMERA, KARAKTER,
    SZOT_HU, SZOT_EN, MAGYAR_SZOVEG, DIREKCIO, INT, KIEJTES,
    ANGOL_SZOVEG, FORD_MEGJEGYZES, TAKE
"""

import argparse
import csv
import re
import sys
from difflib import SequenceMatcher


HU_VOWELS = set("aáeéiíoóöőuúüű")
EN_VOWELS = set("aeiou")


def count_vowels(text: str, vowel_set: set) -> int:
    return sum(1 for c in text.lower() if c in vowel_set)


def fmt_tc(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    h, rem = divmod(total_ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def parse_srt(path: str) -> list[dict]:
    """Parse SRT into list of {idx, start, end, text}."""
    segments = []
    with open(path, encoding="utf-8") as f:
        content = f.read()
    blocks = re.split(r"\n\n+", content.strip())
    for block in blocks:
        lines = block.strip().splitlines()
        if len(lines) < 3:
            continue
        try:
            idx = int(lines[0].strip())
        except ValueError:
            continue
        tc_line = lines[1]
        m = re.match(
            r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})",
            tc_line,
        )
        if not m:
            continue
        def to_sec(h, mm, ss, ms):
            return int(h) * 3600 + int(mm) * 60 + int(ss) + int(ms) / 1000
        start = to_sec(*m.groups()[:4])
        end = to_sec(*m.groups()[4:])
        text = " ".join(lines[2:]).strip()
        segments.append({"idx": idx, "start": start, "end": end, "text": text})
    return segments


def similarity(a: str, b: str) -> float:
    a = re.sub(r"[^\w\s]", "", a.lower())
    b = re.sub(r"[^\w\s]", "", b.lower())
    return SequenceMatcher(None, a, b).ratio()


def find_best_srt_match(en_text: str, srt_segments: list[dict], used: set) -> dict | None:
    """
    Global best-match across all SRT segments (not forward-only).
    The YouTube source video has scenes in a different order than the CSV,
    so timestamps are non-monotone by design -- that is expected and correct.
    """
    if not en_text.strip():
        return None
    best = None
    best_score = 0.0
    for seg in srt_segments:
        if seg["idx"] in used:
            continue
        score = similarity(en_text, seg["text"])
        if score > best_score:
            best_score = score
            best = seg
    # Accept if score > 0.30, or short line with > 0.20
    min_score = 0.30 if len(en_text.split()) > 3 else 0.20
    if best and best_score >= min_score:
        return best
    return None


def parse_source_csv(path: str) -> tuple[list[dict], list[dict]]:
    """
    Parse the original dubscript CSV.
    Returns (scene_rows, dialogue_rows).
    scene_rows: {scene_num, tc_range, row_idx}
    dialogue_rows: {row_num, character, hu_text, note, en_text, ford_note, scene_num}
    """
    with open(path, encoding="utf-8") as f:
        rows = list(csv.reader(f))

    scene_rows = []
    dialogue_rows = []
    current_scene = 0

    for i, row in enumerate(rows):
        if not row:
            continue
        col0 = row[0].strip()
        # Scene header: "0. / 0:00 - 1:06" or "2. / 1:39 - 4:16"
        if re.match(r"^\d+\.\s*/\s*\d+:\d+", col0):
            m = re.match(r"^(\d+)\.\s*/\s*(.+)$", col0)
            if m:
                current_scene = int(m.group(1))
                scene_rows.append({
                    "scene_num": current_scene,
                    "tc_range": m.group(2).strip(),
                    "row_idx": i,
                })
            continue
        # Dialogue row: col0 is a number
        if re.match(r"^\d+$", col0):
            en_text = row[5].strip() if len(row) > 5 else ""
            ford_note = row[4].strip() if len(row) > 4 else ""
            dialogue_rows.append({
                "row_num": int(col0),
                "character": row[1].strip() if len(row) > 1 else "",
                "hu_text": row[2].strip() if len(row) > 2 else "",
                "note": row[3].strip() if len(row) > 3 else "",
                "ford_note": ford_note,
                "en_text": en_text,
                "scene_num": current_scene,
            })
    return scene_rows, dialogue_rows


def build_global_id(scene_num: int, row_num: int) -> str:
    return f"S{scene_num:02d}-{row_num:03d}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="Original dubscript CSV")
    ap.add_argument("--srt", required=True, help="faster-whisper SRT output (EN)")
    ap.add_argument("--out", required=True, help="Output CSV path")
    ap.add_argument("--min-score", type=float, default=0.25, help="Minimum match score (0-1)")
    args = ap.parse_args()

    print(f"Loading SRT: {args.srt}")
    srt_segments = parse_srt(args.srt)
    print(f"  {len(srt_segments)} SRT segments")

    print(f"Loading CSV: {args.csv}")
    scene_rows, dialogue_rows = parse_source_csv(args.csv)
    print(f"  {len(dialogue_rows)} dialogue rows, {len(scene_rows)} scenes")

    used_srt = set()
    output_rows = []
    matched = 0
    unmatched = 0
    unmatched_rows = []

    for dr in dialogue_rows:
        en = dr["en_text"]
        hu = dr["hu_text"]
        char = dr["character"]
        scene = dr["scene_num"]
        row_num = dr["row_num"]

        global_id = build_global_id(scene, row_num)
        hu_sylls = count_vowels(hu, HU_VOWELS)
        en_sylls = count_vowels(en, EN_VOWELS)

        tc_in = ""
        tc_out = ""
        dur = ""

        if en.strip():
            best = find_best_srt_match(en, srt_segments, used_srt)
            if best:
                used_srt.add(best["idx"])
                tc_in = fmt_tc(best["start"])
                tc_out = fmt_tc(best["end"])
                dur = f"{best['end'] - best['start']:.2f}"
                matched += 1
            else:
                unmatched += 1
                unmatched_rows.append((global_id, char, en[:60]))

        output_rows.append({
            "GLOBAL_ID": global_id,
            "#": row_num,
            "TC_IN": tc_in,
            "TC_OUT": tc_out,
            "DUR": dur,
            "KAMERA": "",  # rendezoi mezo - ures
            "KARAKTER": char,
            "SZOT_HU": hu_sylls,
            "SZOT_EN": en_sylls,
            "MAGYAR_SZOVEG": hu,
            "DIREKCIO": "",  # rendezoi mezo - ures
            "INT": "",       # rendezoi mezo - ures
            "KIEJTES": "",
            "ANGOL_SZOVEG": en,
            "FORD_MEGJEGYZES": dr["ford_note"],
            "TAKE": "",
        })

    print(f"Matched: {matched}/{len(dialogue_rows)}, Unmatched: {unmatched}")
    if unmatched_rows:
        print(f"\nUnmatched rows ({len(unmatched_rows)}) -- no TC assigned, manual review needed:")
        for gid, char, en_snip in unmatched_rows:
            print(f"  {gid}  [{char}]  \"{en_snip}...\"" if len(en_snip) == 60 else f"  {gid}  [{char}]  \"{en_snip}\"")

    fieldnames = [
        "GLOBAL_ID", "#", "TC_IN", "TC_OUT", "DUR", "KAMERA", "KARAKTER",
        "SZOT_HU", "SZOT_EN", "MAGYAR_SZOVEG", "DIREKCIO", "INT", "KIEJTES",
        "ANGOL_SZOVEG", "FORD_MEGJEGYZES", "TAKE",
    ]
    with open(args.out, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(output_rows)

    print(f"Output: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
