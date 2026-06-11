#!/usr/bin/env python3
"""Look up concepts in a store/concept-index.json by keyword.

Index schema (concept -> stats):
    {
      "memory tiering": {"count": 12, "sources": ["a.md", "b.md"]},
      "watchdog":       {"count": 7,  "sources": ["b.md", "c.md"]},
      ...
    }

Given a query keyword, return the matching concept entries (substring match,
case-insensitive) ranked by count descending, then by concept name for a
stable tie-break. For the best match it also surfaces "related" concepts:
other concepts that share at least one source file, ranked by the number of
shared sources (then by count, then name).

Pure stdlib. Importable (load_index / lookup / related_concepts) and a CLI.

Usage:
    ./concept-lookup.py --index store/concept-index.json watchdog
    ./concept-lookup.py --index store/concept-index.json --json memory
"""
import argparse
import json
import sys
from pathlib import Path


def load_index(path):
    """Load a concept index json file into a dict. Raises on malformed input."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("concept index must be a JSON object (concept -> stats)")
    return data


def _entry_sources(entry):
    """Normalize an entry's source list (tolerate missing/None)."""
    sources = entry.get("sources") if isinstance(entry, dict) else None
    return [s for s in sources if isinstance(s, str)] if isinstance(sources, list) else []


def _entry_count(entry):
    """Normalize an entry's count (tolerate missing/non-int)."""
    if not isinstance(entry, dict):
        return 0
    count = entry.get("count", 0)
    return count if isinstance(count, int) else 0


def lookup(index, query):
    """Return matching concept entries ranked by count desc, then name asc.

    Match is a case-insensitive substring on the concept name. An empty query
    matches every concept. Each result is a dict:
        {"concept": str, "count": int, "sources": [str, ...]}
    """
    needle = query.lower()
    results = []
    for concept, entry in index.items():
        if needle in concept.lower():
            results.append({
                "concept": concept,
                "count": _entry_count(entry),
                "sources": _entry_sources(entry),
            })
    results.sort(key=lambda r: (-r["count"], r["concept"]))
    return results


def related_concepts(index, concept):
    """Return concepts sharing >=1 source file with `concept`.

    Ranked by shared-source count desc, then total count desc, then name asc.
    The concept itself is excluded. Returns [] if the concept is absent or has
    no sources.
    """
    target = index.get(concept)
    if target is None:
        return []
    target_sources = set(_entry_sources(target))
    if not target_sources:
        return []

    related = []
    for other, entry in index.items():
        if other == concept:
            continue
        shared = target_sources & set(_entry_sources(entry))
        if shared:
            related.append({
                "concept": other,
                "shared": sorted(shared),
                "shared_count": len(shared),
                "count": _entry_count(entry),
                "sources": _entry_sources(entry),
            })
    related.sort(key=lambda r: (-r["shared_count"], -r["count"], r["concept"]))
    return related


def lookup_with_related(index, query):
    """Convenience: ranked matches plus related concepts for the top match."""
    matches = lookup(index, query)
    related = related_concepts(index, matches[0]["concept"]) if matches else []
    return {"matches": matches, "related": related}


def _format_text(result, query):
    lines = []
    matches = result["matches"]
    if not matches:
        lines.append(f"No concept matches '{query}'.")
        return "\n".join(lines)
    lines.append(f"Matches for '{query}' ({len(matches)}):")
    for r in matches:
        srcs = ", ".join(r["sources"]) if r["sources"] else "-"
        lines.append(f"  [{r['count']:>4}] {r['concept']}  ({srcs})")
    if result["related"]:
        top = matches[0]["concept"]
        lines.append(f"Related to '{top}':")
        for r in result["related"]:
            shared = ", ".join(r["shared"])
            lines.append(
                f"  [{r['count']:>4}] {r['concept']}  "
                f"(shares {r['shared_count']}: {shared})"
            )
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Look up concepts in a concept-index.json by keyword."
    )
    parser.add_argument(
        "--index",
        default="store/concept-index.json",
        help="Path to the concept index json (default: store/concept-index.json).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON instead of human-readable text.",
    )
    parser.add_argument("query", help="Keyword to look up (case-insensitive substring).")
    args = parser.parse_args(argv)

    index_path = Path(args.index)
    if not index_path.exists():
        print(f"error: index not found: {index_path}", file=sys.stderr)
        return 2
    try:
        index = load_index(index_path)
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"error: failed to load index: {exc}", file=sys.stderr)
        return 2

    result = lookup_with_related(index, args.query)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(_format_text(result, args.query))
    return 0 if result["matches"] else 1


if __name__ == "__main__":
    sys.exit(main())
