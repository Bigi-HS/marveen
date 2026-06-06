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

# 1. micromamba static binary (no sudo). The host has no bzip2, so extract the
#    .tar.bz2 with python's bz2 stdlib, not tar.
curl -Ls -o /tmp/mm.tar.bz2 https://micro.mamba.pm/api/micromamba/linux-64/latest
python3 - <<'PY'
import tarfile, os
with tarfile.open("/tmp/mm.tar.bz2","r:bz2") as t:
    m=t.getmember("bin/micromamba"); m.name="micromamba"
    t.extract(m,"store/whisper-env/bin")
os.chmod("store/whisper-env/bin/micromamba",0o755)
PY

# 2. env: python 3.11 + ffmpeg (prebuilt, conda-forge)
export MAMBA_ROOT_PREFIX=/home/domin/marveen/store/whisper-env
store/whisper-env/bin/micromamba create -y -p store/whisper-env/env \
    -c conda-forge python=3.11 ffmpeg pip

# 3. python deps (prebuilt wheels for cp311 -- no compiler needed)
store/whisper-env/env/bin/pip install faster-whisper yt-dlp
```

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
