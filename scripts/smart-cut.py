#!/usr/bin/env python3
"""
smart-cut.py -- Transcript-alapú + silencedetect-alapú smart cut pilot.

Két mód:
  --mode srt     : csak Whisper SRT rések + fillerszavak alapján (nincs audio szükséges)
  --mode silence : FFmpeg silencedetect az audio-n (pontosabb, de audio szükséges)

Kimenet: FFmpeg concat filter script (.txt) + összefoglaló riport.

Usage:
  python3 smart-cut.py --srt store/transcripts/XYZ.srt [--mode srt] [--min-gap 0.5] [--out-dir /tmp]
  python3 smart-cut.py --audio /path/to/audio.wav [--mode silence] [--noise -35] [--duration 0.5]
  python3 smart-cut.py --srt store/transcripts/XYZ.srt --audio /path/audio.wav [--mode both]
"""

import argparse
import re
import subprocess
import sys
import os
from pathlib import Path

FFMPEG = "/home/domin/marveen/store/whisper-env/env/bin/ffmpeg"

# Magyar + angol fillerszavak
FILLERS = {
    "hu": {"szóval","tehát","ugye","hát","igen","uh","um","öö","hmm","úgyhogy","mondjuk","tulajdonképpen"},
    "en": {"um","uh","like","you know","so","right","actually","basically","literally","i mean","kind of"},
}
ALL_FILLERS = FILLERS["hu"] | FILLERS["en"]


def tc2s(tc: str) -> float:
    tc = tc.strip().replace(",", ".")
    parts = tc.split(":")
    h, m, s = int(parts[0]), int(parts[1]), float(parts[2])
    return h * 3600 + m * 60 + s


def s2tc(sec: float) -> str:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def parse_srt(path: str):
    with open(path, encoding="utf-8", errors="replace") as f:
        content = f.read()
    segments = []
    for block in re.split(r"\n\n+", content.strip()):
        lines = block.strip().splitlines()
        if len(lines) < 3:
            continue
        m = re.match(r"(\d{2}:\d{2}:\d{2}[,\.]\d+)\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d+)", lines[1])
        if not m:
            continue
        segments.append({
            "start": tc2s(m.group(1)),
            "end":   tc2s(m.group(2)),
            "text":  " ".join(lines[2:]).strip(),
        })
    return segments


def find_srt_gaps(segments, min_gap: float = 0.5):
    """Rések az SRT szegmensek között (csend / szünet)."""
    cuts = []
    for i in range(1, len(segments)):
        gap = segments[i]["start"] - segments[i - 1]["end"]
        if gap >= min_gap:
            cuts.append({
                "type": "silence-gap",
                "start": segments[i - 1]["end"],
                "end":   segments[i]["start"],
                "dur":   gap,
                "reason": f"{gap:.2f}s csend az SRT-ben",
            })
    return cuts


def find_filler_segments(segments, filler_threshold: float = 1.5):
    """Rövid fillerszavas szegmensek azonosítása."""
    cuts = []
    for seg in segments:
        text_lower = seg["text"].lower().strip(".,!?-")
        dur = seg["end"] - seg["start"]
        # Rövid szegmens ÉS filler szó
        is_filler = any(text_lower == f or text_lower.startswith(f + " ") for f in ALL_FILLERS)
        is_short = dur <= filler_threshold
        if is_filler and is_short:
            cuts.append({
                "type": "filler",
                "start": seg["start"],
                "end":   seg["end"],
                "dur":   dur,
                "reason": f"filler: '{seg['text']}' ({dur:.2f}s)",
            })
    return cuts


def run_silencedetect(audio_path: str, noise_db: int = -35, min_dur: float = 0.5):
    """FFmpeg silencedetect filter futtatása."""
    cmd = [
        FFMPEG, "-i", audio_path,
        "-af", f"silencedetect=noise={noise_db}dB:d={min_dur}",
        "-f", "null", "-"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    output = result.stderr

    cuts = []
    starts = re.findall(r"silence_start: ([\d.]+)", output)
    ends   = re.findall(r"silence_end: ([\d.]+)", output)
    for s, e in zip(starts, ends):
        s, e = float(s), float(e)
        cuts.append({
            "type": "silence-audio",
            "start": s,
            "end":   e,
            "dur":   e - s,
            "reason": f"{e-s:.2f}s audio-csend ({noise_db}dB)",
        })
    return cuts


def cuts_to_keep_segments(total_dur: float, cuts):
    """Fordítja a cut-listát keep-listává (mi maradjon)."""
    # Rendezés + merge
    sorted_cuts = sorted(cuts, key=lambda x: x["start"])
    merged = []
    for cut in sorted_cuts:
        if merged and cut["start"] <= merged[-1]["end"] + 0.05:
            merged[-1]["end"] = max(merged[-1]["end"], cut["end"])
        else:
            merged.append(dict(cut))

    keep = []
    pos = 0.0
    for cut in merged:
        if cut["start"] > pos + 0.05:
            keep.append({"start": pos, "end": cut["start"]})
        pos = cut["end"]
    if pos < total_dur - 0.05:
        keep.append({"start": pos, "end": total_dur})
    return keep, merged


def write_ffmpeg_concat(keep_segments, output_path: str, input_label: str = "input"):
    """FFmpeg select filter parancs generálása (concat demuxer helyett -- egyszerűbb)."""
    parts = []
    for seg in keep_segments:
        parts.append(f"between(t,{seg['start']:.3f},{seg['end']:.3f})")
    select_expr = "+".join(parts)

    lines = [
        f"# FFmpeg smart-cut parancs (generálva: smart-cut.py)",
        f"# Input: {input_label}",
        f"# Keep szegmensek: {len(keep_segments)}",
        f"",
        f"ffmpeg -i INPUT_FILE \\",
        f'  -vf "select=\'{select_expr}\',setpts=N/FRAME_RATE/TB" \\',
        f'  -af "aselect=\'{select_expr}\',asetpts=N/SR/TB" \\',
        f"  OUTPUT_FILE.mp4",
        f"",
        f"# Keep szegmensek részletesen:",
    ]
    for i, seg in enumerate(keep_segments, 1):
        lines.append(f"#   {i:3d}. {s2tc(seg['start'])} --> {s2tc(seg['end'])}  ({seg['end']-seg['start']:.2f}s)")

    with open(output_path, "w") as f:
        f.write("\n".join(lines))
    return output_path


def report(segments, cuts_merged, keep_segments, mode):
    total_dur = segments[-1]["end"] if segments else 0
    original_speech = sum(s["end"] - s["start"] for s in segments)
    cut_time = sum(c["dur"] for c in cuts_merged)
    keep_time = sum(s["end"] - s["start"] for s in keep_segments)
    saved_pct = cut_time / total_dur * 100 if total_dur else 0

    print(f"\n{'='*55}")
    print(f"  SMART-CUT PILOT RIPORT  [{mode}]")
    print(f"{'='*55}")
    print(f"  Videó hossza:     {total_dur:.1f}s  ({total_dur/60:.1f} perc)")
    print(f"  Maradó tartalom:  {keep_time:.1f}s  ({keep_time/60:.1f} perc)")
    print(f"  Kivágott idő:     {cut_time:.1f}s  ({saved_pct:.1f}%)")
    print(f"  Vágási pontok:    {len(cuts_merged)}")
    print(f"  Keep szegmensek:  {len(keep_segments)}")
    print(f"\n  Kivágások típusonként:")
    from collections import Counter
    type_counts = Counter(c["type"] for c in cuts_merged)
    for t, n in type_counts.items():
        print(f"    {t}: {n} db")
    print(f"\n  Top 5 kivágás (leghosszabb):")
    for c in sorted(cuts_merged, key=lambda x: -x["dur"])[:5]:
        print(f"    {s2tc(c['start'])} --> {s2tc(c['end'])}  [{c['dur']:.2f}s]  {c['reason']}")
    print(f"{'='*55}\n")


def main():
    ap = argparse.ArgumentParser(description="Smart-cut: transcript + silence alapú FFmpeg vágólista")
    ap.add_argument("--srt",      help="Whisper SRT fájl")
    ap.add_argument("--audio",    help="Audio fájl (WAV/MP4) silencedetect-hez")
    ap.add_argument("--mode",     choices=["srt","silence","both"], default="srt")
    ap.add_argument("--min-gap",  type=float, default=0.5,  help="Min. SRT rés (mp) ami vágandó (default 0.5)")
    ap.add_argument("--noise",    type=int,   default=-35,  help="silencedetect zaj küszöb dB (default -35)")
    ap.add_argument("--duration", type=float, default=0.5,  help="Min. csend hossz sec (default 0.5)")
    ap.add_argument("--out-dir",  default=".", help="Kimenet mappa")
    args = ap.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)

    cuts = []

    if args.mode in ("srt", "both"):
        if not args.srt:
            print("ERROR: --srt kötelező srt/both módban", file=sys.stderr)
            sys.exit(1)
        segments = parse_srt(args.srt)
        if not segments:
            print("ERROR: üres vagy hibás SRT", file=sys.stderr)
            sys.exit(1)
        print(f"SRT: {len(segments)} szegmens, {segments[-1]['end']:.1f}s")
        cuts += find_srt_gaps(segments, min_gap=args.min_gap)
        cuts += find_filler_segments(segments)

    if args.mode in ("silence", "both"):
        if not args.audio:
            print("ERROR: --audio kötelező silence/both módban", file=sys.stderr)
            sys.exit(1)
        print(f"silencedetect: {args.audio} ...")
        cuts += run_silencedetect(args.audio, noise_db=args.noise, min_dur=args.duration)

    if not cuts:
        print("Nincs vágandó szegmens a megadott küszöbökkel.")
        sys.exit(0)

    if args.mode == "silence" and args.audio:
        # Audio hosszát ffprobe-bal
        r = subprocess.run(
            ["ffprobe","-v","error","-show_entries","format=duration",
             "-of","default=noprint_wrappers=1:nokey=1", args.audio],
            capture_output=True, text=True
        )
        total_dur = float(r.stdout.strip()) if r.stdout.strip() else 0
        # dummy segments for report
        segments = [{"start":0,"end":total_dur,"text":""}]
    elif args.srt:
        segments = parse_srt(args.srt)

    keep, merged = cuts_to_keep_segments(segments[-1]["end"], cuts)
    report(segments, merged, keep, args.mode)

    # FFmpeg script kiírása
    srt_name = Path(args.srt).stem if args.srt else Path(args.audio).stem
    out_script = os.path.join(args.out_dir, f"{srt_name}-smartcut.sh")
    write_ffmpeg_concat(keep, out_script, srt_name)
    print(f"FFmpeg script: {out_script}")


if __name__ == "__main__":
    main()
