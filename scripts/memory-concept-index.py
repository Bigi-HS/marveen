#!/usr/bin/env python3
"""Compile a concept index over the Genesis memory vault (stdlib only).

Inspired by coleam00's compile.py "compile-phase over a vault": instead of
re-reading every memory file at query time, we run a cheap offline pass that
extracts the salient concepts (keyword / noun-phrase frequency plus pairwise
co-occurrence) and emits a compact JSON index. Downstream tooling (semantic
search, daily-log summarisation, ReasoningBank) can then load one small file
instead of scanning the whole vault.

Scanned inputs under --root:
  - memory/daily-log/*  (plain-text daily logs, any extension)
  - memory/**/*.md      (markdown memory topic files)
  - *.md at the root    (e.g. MEMORY.md, DREAM.md)

Output (--out, default store/concept-index.json):

    {
      "generated_at": <unix-ts>,
      "root": "<abs root>",
      "file_count": <int>,
      "concepts": {
        "<concept>": {
          "count": <int>,                 # total occurrences across the vault
          "sources": ["<rel-path>", ...]  # files the concept appears in (sorted)
        },
        ...
      },
      "cooccurrence": {
        "<conceptA>|<conceptB>": <int>,   # A < B lexically; same-file co-mentions
        ...
      }
    }

CLI:
    scripts/memory-concept-index.py --root ~/.claude/projects/<p>/memory \
        --out store/concept-index.json

Importable:
    from memory_concept_index import build_index
    index = build_index(root)        # returns the dict above

Pure stdlib: no external dependencies.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

# --- tuning knobs ---------------------------------------------------------

# Files larger than this are skipped (defensive against binary/huge blobs).
MAX_FILE_BYTES = 2_000_000

# A concept must occur at least this many times in a single file to count it
# as "present" in that file (filters one-off noise words).
MIN_FILE_OCCURRENCES = 1

# A concept must reach this total count across the vault to make the index.
MIN_TOTAL_COUNT = 2

# Keep at most this many concepts (highest-count first) to bound output size.
MAX_CONCEPTS = 2000

# Word token: letters/digits, must start with a letter, length >= 3.
_WORD_RE = re.compile(r"\b[a-zA-Z][a-zA-Z0-9]{2,}\b")

# Two-word noun-phrase candidate (adjacent capitalised or hyphenated terms are
# common in this vault, e.g. "concept index", "daily log"). We lowercase and
# join with a single space.
_PHRASE_RE = re.compile(
    r"\b([a-zA-Z][a-zA-Z0-9]{2,})[ \-]([a-zA-Z][a-zA-Z0-9]{2,})\b"
)

# Common English / markdown stopwords that carry no concept signal.
STOPWORDS = frozenset(
    """
    the and for are but not you all any can her was one our out has had his how
    its may new now old see two way who did get use man day too own she use end
    far off per via etc into more most such than then them they this that with
    from your have will been were what when then there here over under about
    after again also because before being below both does down each even ever
    every from further once only other same some still very well were while
    would about above across against along among around could should their these
    those through under until where which whose http https www com org net md
    txt json log file files line lines code note notes via per
    """.split()
)


def _iter_target_files(root: Path) -> Iterable[Path]:
    """Yield the memory files we index, in a deterministic order."""
    candidates: List[Path] = []

    # Root-level markdown (MEMORY.md, DREAM.md, ...).
    candidates.extend(sorted(root.glob("*.md")))

    mem = root / "memory"
    if mem.is_dir():
        # Daily-log files (any extension).
        daily = mem / "daily-log"
        if daily.is_dir():
            candidates.extend(sorted(p for p in daily.rglob("*") if p.is_file()))
        # All markdown memory topic files, recursively.
        candidates.extend(sorted(mem.rglob("*.md")))

    seen = set()
    for p in candidates:
        rp = p.resolve()
        if rp in seen:
            continue
        seen.add(rp)
        try:
            if p.is_file() and p.stat().st_size <= MAX_FILE_BYTES:
                yield p
        except OSError:
            continue


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _extract_concepts(text: str) -> Counter:
    """Return a Counter of concept -> occurrences for a single document.

    Concepts are single salient words plus two-word phrases. Markdown noise
    (code fences, inline code, urls) is stripped first.
    """
    # Drop fenced code blocks and inline code so we index prose, not snippets.
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    text = re.sub(r"`[^`]*`", " ", text)
    # Drop urls.
    text = re.sub(r"https?://\S+", " ", text)

    counts: Counter = Counter()

    for m in _WORD_RE.finditer(text):
        w = m.group(0).lower()
        if w in STOPWORDS:
            continue
        counts[w] += 1

    for m in _PHRASE_RE.finditer(text):
        a, b = m.group(1).lower(), m.group(2).lower()
        if a in STOPWORDS or b in STOPWORDS:
            continue
        counts[f"{a} {b}"] += 1

    return counts


def build_index(root) -> Dict:
    """Scan the memory vault under ``root`` and build the concept index dict.

    ``root`` may be a str or Path. Returns the index structure documented in
    the module docstring. Safe on an empty or missing vault (yields an empty
    concept map rather than raising).
    """
    root = Path(root).expanduser().resolve()

    total_counts: Counter = Counter()
    sources: Dict[str, set] = defaultdict(set)
    cooc: Counter = Counter()
    file_count = 0

    for path in _iter_target_files(root):
        text = _read_text(path)
        if not text.strip():
            continue
        file_count += 1
        try:
            rel = str(path.resolve().relative_to(root))
        except ValueError:
            rel = str(path.resolve())

        doc_counts = _extract_concepts(text)
        present: List[str] = []
        for concept, n in doc_counts.items():
            if n < MIN_FILE_OCCURRENCES:
                continue
            total_counts[concept] += n
            sources[concept].add(rel)
            present.append(concept)

        # Pairwise co-occurrence within this document (concepts that survived
        # the per-file threshold). Bounded by sorting + cap to keep it cheap.
        present_sorted = sorted(set(present))
        if len(present_sorted) > 1:
            # Cap per-file pairs to avoid quadratic blow-up on huge docs.
            top = sorted(
                present_sorted, key=lambda c: doc_counts[c], reverse=True
            )[:60]
            top.sort()
            for i in range(len(top)):
                for j in range(i + 1, len(top)):
                    cooc[f"{top[i]}|{top[j]}"] += 1

    # Threshold + rank + cap the concept map.
    ranked = [
        (c, n) for c, n in total_counts.items() if n >= MIN_TOTAL_COUNT
    ]
    ranked.sort(key=lambda kv: (-kv[1], kv[0]))
    ranked = ranked[:MAX_CONCEPTS]
    kept = {c for c, _ in ranked}

    concepts = {
        c: {"count": n, "sources": sorted(sources[c])}
        for c, n in ranked
    }

    # Keep only co-occurrence pairs where both endpoints survived.
    cooccurrence = {
        pair: n
        for pair, n in sorted(cooc.items(), key=lambda kv: (-kv[1], kv[0]))
        if pair.split("|", 1)[0] in kept and pair.split("|", 1)[1] in kept
    }

    return {
        "generated_at": int(time.time()),
        "root": str(root),
        "file_count": file_count,
        "concepts": concepts,
        "cooccurrence": cooccurrence,
    }


def write_index(index: Dict, out) -> Path:
    """Write ``index`` as pretty JSON to ``out``, creating parent dirs."""
    out = Path(out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(index, indent=2, ensure_ascii=False, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    return out


def _default_out() -> Path:
    # store/ lives at the repo root, two levels up from this script's dir.
    return Path(__file__).resolve().parent.parent / "store" / "concept-index.json"


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Compile a concept index over the memory vault (stdlib only)."
    )
    ap.add_argument(
        "--root",
        required=True,
        help="Vault root containing MEMORY.md and memory/ (daily-log + *.md).",
    )
    ap.add_argument(
        "--out",
        default=None,
        help="Output JSON path (default: store/concept-index.json).",
    )
    args = ap.parse_args(argv)

    out = Path(args.out) if args.out else _default_out()
    index = build_index(args.root)
    written = write_index(index, out)
    print(
        f"concept-index: {len(index['concepts'])} concepts from "
        f"{index['file_count']} files -> {written}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
