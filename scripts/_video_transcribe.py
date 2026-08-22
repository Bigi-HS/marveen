#!/usr/bin/env python3
"""
faster-whisper transcription helper (called by video-transcribe.sh).

Reads a 16 kHz mono WAV, transcribes with faster-whisper (CTranslate2, CPU int8),
and writes a timestamped plain-text transcript and an SRT subtitle file.

With --word-timestamps: also writes a word-level SRT (.words.srt) for caption
sync precision. Word-level SRT keeps each word as a separate cue so downstream
tools (HyperFrames, dubscript-tc-import) can achieve <±0.1s alignment.

Run via the dedicated env's python (absolute path), e.g.:
  store/whisper-env/env/bin/python scripts/_video_transcribe.py \
      --audio /tmp/x.wav --out-base /tmp/x --model medium --lang hu

Model files are cached under the env (download_root) so the install stays
self-contained and documented (see scripts/video-transcribe.md).
"""

import argparse
import os
import sys


def fmt_ts(seconds: float, sep: str = ",") -> str:
    """Seconds -> HH:MM:SS,mmm (SRT) or HH:MM:SS.mmm (txt) timestamp."""
    if seconds < 0:
        seconds = 0.0
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out-base", required=True, help="output path without extension")
    ap.add_argument("--model", default="medium")
    ap.add_argument("--lang", default="auto", help="hu | en | auto (source speech language)")
    ap.add_argument("--download-root", default=None, help="model cache dir")
    ap.add_argument("--word-timestamps", action="store_true", default=False,
                    help="Also write word-level SRT (.words.srt) for caption sync precision")
    args = ap.parse_args()

    if not os.path.isfile(args.audio):
        print(f"ERROR: audio not found: {args.audio}", file=sys.stderr)
        return 4

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # pragma: no cover
        print(f"ERROR: faster-whisper import failed: {e}", file=sys.stderr)
        return 5

    language = None if args.lang == "auto" else args.lang

    # CPU int8: the fastest accurate mode on a GPU-less host.
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=args.download_root,
    )

    # Transcribe in the SOURCE language (detected or forced via --lang). The
    # transcript is intentionally same-language as the speech (no translation --
    # out of scope; the tool just handles both HU and EN sources).
    segments, info = model.transcribe(
        args.audio,
        language=language,
        vad_filter=True,  # drop long silences -> faster + cleaner timestamps
        beam_size=5,
        word_timestamps=args.word_timestamps,
    )

    txt_path = args.out_base + ".txt"
    srt_path = args.out_base + ".srt"
    words_srt_path = args.out_base + ".words.srt" if args.word_timestamps else None

    n = 0
    word_cue = 0
    fsrt_words = open(words_srt_path, "w", encoding="utf-8") if words_srt_path else None

    try:
        with open(txt_path, "w", encoding="utf-8") as ftxt, \
             open(srt_path, "w", encoding="utf-8") as fsrt:
            for i, seg in enumerate(segments, start=1):
                text = seg.text.strip()
                ftxt.write(f"[{fmt_ts(seg.start, '.')} -> {fmt_ts(seg.end, '.')}] {text}\n")
                fsrt.write(f"{i}\n{fmt_ts(seg.start)} --> {fmt_ts(seg.end)}\n{text}\n\n")
                n += 1

                # Word-level SRT: one cue per word
                if fsrt_words and seg.words:
                    for w in seg.words:
                        word_cue += 1
                        word_text = w.word.strip()
                        fsrt_words.write(
                            f"{word_cue}\n"
                            f"{fmt_ts(w.start)} --> {fmt_ts(w.end)}\n"
                            f"{word_text}\n\n"
                        )
    finally:
        if fsrt_words:
            fsrt_words.close()

    # Machine-readable summary on stdout for the shell wrapper.
    print(f"DETECTED_LANG={info.language} LANG_PROB={info.language_probability:.2f} "
          f"DURATION={info.duration:.1f} SEGMENTS={n}")
    print(f"TXT={txt_path}")
    print(f"SRT={srt_path}")
    if words_srt_path:
        print(f"WORDS_SRT={words_srt_path}")
    if n == 0:
        print("WARN: no speech segments produced", file=sys.stderr)
        return 6
    return 0


if __name__ == "__main__":
    sys.exit(main())
