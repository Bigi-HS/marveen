# Video transcription (platform-independent)

Transcribes any web video's **speech** independent of the platform's own
auto-captions (which are often missing or inaccurate). Pipeline:

```
yt-dlp (audio)  ->  ffmpeg (16 kHz mono WAV)  ->  faster-whisper (CPU int8)  ->  .txt + .srt
```

Handles **Hungarian and English** (multilingual whisper model).

## Why this stack

The host has **no C++ compiler and no sudo**, so `whisper.cpp` cannot be built.
`faster-whisper` ships prebuilt CTranslate2 wheels, runs CPU-only, is fast +
accurate, and handles Hungarian. Everything lives in a **self-contained
micromamba environment** so nothing touches system packages.

## Layout (fixed, documented)

```
store/whisper-env/bin/micromamba     # the package manager (static binary)
store/whisper-env/env/               # the env: python 3.11 + ffmpeg + faster-whisper + yt-dlp
store/whisper-env/models/            # downloaded CTranslate2 models (cache)
store/transcripts/                   # default output dir (.txt + .srt)
```

`store/` is gitignored, so the env + models are never committed. The script
calls the env's binaries by **absolute path** -- it does not rely on `PATH`.

## Rebuild recipe (after a reboot / new machine)

No auto-reinstall; run these once to recreate `store/whisper-env/`:

```bash
cd /home/domin/marveen
mkdir -p store/whisper-env/bin

# 1. micromamba static binary (no sudo), PINNED version + sha256-verified.
#    The host has no bzip2, so extract the .tar.bz2 with python's bz2 stdlib.
MM_VER=2.8.0
MM_SHA=d4f5869b8b5b8e4e8b10375d84ae998edb3f4b439e05228fc5099082935a75ec
curl -Ls -o /tmp/mm.tar.bz2 "https://micro.mamba.pm/api/micromamba/linux-64/${MM_VER}"
python3 - "$MM_SHA" <<'PY'
import hashlib, sys, tarfile, os
want = sys.argv[1]
got = hashlib.sha256(open("/tmp/mm.tar.bz2","rb").read()).hexdigest()
if got != want:
    sys.exit(f"micromamba sha256 MISMATCH: got {got} want {want}")
with tarfile.open("/tmp/mm.tar.bz2","r:bz2") as t:
    m=t.getmember("bin/micromamba"); m.name="micromamba"
    t.extract(m,"store/whisper-env/bin")
os.chmod("store/whisper-env/bin/micromamba",0o755)
PY

# 2. env: python 3.11 + ffmpeg (prebuilt, conda-forge)
export MAMBA_ROOT_PREFIX=/home/domin/marveen/store/whisper-env
store/whisper-env/bin/micromamba create -y -p store/whisper-env/env \
    -c conda-forge python=3.11 ffmpeg pip

# 3. python deps PINNED (prebuilt cp311 wheels -- no compiler needed)
store/whisper-env/env/bin/pip install 'faster-whisper==1.2.1' 'yt-dlp==2026.3.17'
```

Pinned reference versions (the set this was built + validated against):
micromamba 2.8.0, python 3.11, ffmpeg 8.1, faster-whisper 1.2.1 (ctranslate2
4.7.2), yt-dlp 2026.03.17. `yt-dlp` may be bumped if a site extractor breaks.

Verify: `store/whisper-env/env/bin/yt-dlp --version` and
`store/whisper-env/env/bin/python -c "import faster_whisper"`.

## Usage

```bash
scripts/video-transcribe.sh <url> [--lang hu|en|auto] [--model small|medium] [--out-dir DIR]
```

- `--lang` default `auto` (whisper detects); force `hu`/`en` for best results.
- `--model` default `medium` (see model note below); `small` is ~3x faster.
- Output: `<out-dir>/<video-id>.txt` (timestamped lines) and `.srt` (subtitles).

Examples:
```bash
scripts/video-transcribe.sh 'https://youtu.be/XXXX'
scripts/video-transcribe.sh 'https://www.twitch.tv/videos/123456789' --lang hu --model medium
```

## Telegram voice messages (per-agent, local, zero cloud token)

Any agent with its own Telegram channel (Genesis, Claudia, Big Ben, ...) can
transcribe an inbound **voice message** locally, reusing this same env. This is
the canonical recipe; per-agent `CLAUDE.md` files are gitignored, so it lives
here (tracked) to stay versioned.

When a channel message arrives with `attachment_kind="voice"` +
`attachment_file_id` and **no** `[Hang átirat]:` prefix (i.e. not already
auto-transcribed), the agent runs, from the repo root `/home/domin/marveen`:

```bash
# 1. fetch the voice file via the agent's own Telegram MCP tool (bot-scoped):
#    download_attachment(attachment_file_id) -> e.g.
#    /home/domin/.claude/channels/telegram/inbox/<...>.oga

# 2. convert to 16 kHz mono WAV with the ENV's ffmpeg (system ffmpeg is absent):
store/whisper-env/env/bin/ffmpeg -y -loglevel error -i <audio.oga> \
    -ar 16000 -ac 1 /tmp/voice.wav

# 3. transcribe with faster-whisper via the shared helper (medium for voice):
store/whisper-env/env/bin/python scripts/_video_transcribe.py \
    --audio /tmp/voice.wav --out-base /tmp/voice \
    --model medium --lang hu --download-root store/whisper-env/models
#    -> /tmp/voice.txt (+ .srt); stdout: DETECTED_LANG= / SEGMENTS=
```

Then treat `/tmp/voice.txt` as a **text instruction**. For irreversible or
precision-critical actions (calendar time/date/attendee, money, deletion,
anything going to a third party), read the understood instruction back for
confirmation before acting.

`download_attachment` is part of each agent's own Telegram MCP server, scoped to
that agent's bot token -- Telegram `file_id`s are bot-specific, so a file sent to
one bot cannot be fetched by another. The ffmpeg + whisper steps are identical to
the video path above.

**Model = `medium`** for voice (not `small`): on short clips `small` garbles
Hungarian morphology ("kíváncsiságból" -> "kíváncsiségból"); `medium`
transcribes cleanly and short voice clips are fast enough regardless.

## Model note (CPU, no GPU) -- measured on this host (20-core CPU)

`large-v3` is too slow on CPU. Measured on a 109 s Hungarian news clip + a 19 s
English clip + a Twitch VOD slice:

| model  | speed (realtime) | Hungarian quality | English quality |
|--------|------------------|-------------------|-----------------|
| small  | ~1.5x (faster)   | gist OK, errors on morphology + proper nouns ("sebesség"->"csebeség") | very good |
| medium | ~1.08x (~realtime) | notably better -- "gyorsforgalmi út", "sebesség óránként", clean numbers | excellent |

**Default = `medium`**: Hungarian quality is the priority and ~realtime on a
20-core CPU is fine for non-realtime transcription. Use `--model small` when you
want ~1.5x speed and the input is English or quality is less critical. (Both still
miss rare proper nouns like the town "Cegléd"; that is a whisper limitation, not
the pipeline.)

## Errors

The script fails loudly with a distinct exit code for: missing env binary (3),
bad/unavailable URL (10), ffmpeg failure (11), transcription failure (12),
no-speech (helper exit 6). Temp audio is cleaned via a trap.

## Later (not built)

A `--frames` mode (ffmpeg keyframe sampling for Claude vision) and a Groq API
fast-lane are possible future options, gated separately.
