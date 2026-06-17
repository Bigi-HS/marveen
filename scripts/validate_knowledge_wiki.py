#!/usr/bin/env python3
"""Skeleton-integrity validator for the LLM knowledge-wiki (card ab196f85, phase-1).

This is a LINT, not the phase-2 auto-indexer: it never generates or rewrites
content, it only verifies the structural invariants a hand-curated wiki must
hold so links and frontmatter cannot silently rot as Applegate adds entries.

Checks:
  1. Every wiki/**/*.md carries YAML frontmatter with the required keys.
  2. Every `related:` target resolves to an existing file (paths are relative
     to the wiki root, e.g. "wiki/foundations/attention-mechanism.md").
  3. Every `sources:` entry (optional) lives under sources/ and exists.
  4. Every markdown link in index.md that points into wiki/ resolves.

Usage: python3 scripts/validate_knowledge_wiki.py [WIKI_ROOT]
Exit 0 = clean, 1 = at least one integrity error (printed to stderr).
"""

import os
import re
import sys

import yaml

REQUIRED_KEYS = ("title", "keywords", "related", "created_at", "updated_at")

# markdown inline link -> capture the target
_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def parse_frontmatter(text):
    """Return (frontmatter_dict_or_None, body). Frontmatter is a leading
    YAML block fenced by '---' lines."""
    if not text.startswith("---"):
        return None, text
    # split off the first fenced block
    rest = text[3:]
    if rest.startswith("\n"):
        rest = rest[1:]
    end = rest.find("\n---")
    if end == -1:
        return None, text
    block = rest[:end]
    body = rest[end + len("\n---"):]
    try:
        data = yaml.safe_load(block)
    except yaml.YAMLError:
        return None, text
    if not isinstance(data, dict):
        return None, text
    return data, body


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def validate_entry(path, root):
    """Validate a single wiki entry file. Return a list of error strings."""
    errors = []
    rel = os.path.relpath(path, root)
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    fm, _ = parse_frontmatter(text)
    if fm is None:
        errors.append(f"{rel}: missing or malformed YAML frontmatter")
        return errors
    for key in REQUIRED_KEYS:
        if key not in fm:
            errors.append(f"{rel}: missing required frontmatter key '{key}'")
    for target in _as_list(fm.get("related")):
        if not os.path.isfile(os.path.join(root, str(target))):
            errors.append(f"{rel}: related link does not resolve -> {target}")
    for src in _as_list(fm.get("sources")):
        src = str(src)
        norm = os.path.normpath(src)
        if not (norm == "sources" or norm.startswith("sources" + os.sep)):
            errors.append(f"{rel}: source path must live under sources/ -> {src}")
        elif not os.path.isfile(os.path.join(root, src)):
            errors.append(f"{rel}: source link does not resolve -> {src}")
    return errors


def validate_index(index_path, root):
    """Validate that every wiki/ link in the master index resolves."""
    errors = []
    with open(index_path, "r", encoding="utf-8") as f:
        text = f.read()
    for target in _LINK_RE.findall(text):
        target = target.strip()
        # only check intra-wiki links into wiki/; skip anchors + external URLs
        if target.startswith("#") or "://" in target:
            continue
        if not target.startswith("wiki/"):
            continue
        link = target.split("#", 1)[0]
        if not os.path.isfile(os.path.join(root, link)):
            errors.append(f"index.md: link does not resolve -> {target}")
    return errors


def _iter_wiki_entries(root):
    wiki_dir = os.path.join(root, "wiki")
    for dirpath, _, filenames in os.walk(wiki_dir):
        for name in sorted(filenames):
            if name.endswith(".md"):
                yield os.path.join(dirpath, name)


def validate_tree(root):
    """Validate the whole wiki tree. Return an aggregated list of errors."""
    errors = []
    for entry in sorted(_iter_wiki_entries(root)):
        errors.extend(validate_entry(entry, root))
    index_path = os.path.join(root, "index.md")
    if os.path.isfile(index_path):
        errors.extend(validate_index(index_path, root))
    return errors


def main(argv):
    root = argv[1] if len(argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "knowledge-wiki"
    )
    if not os.path.isdir(root):
        print(f"knowledge-wiki root not found: {root}", file=sys.stderr)
        return 2
    errors = validate_tree(root)
    if errors:
        for e in errors:
            print("FAIL " + e, file=sys.stderr)
        print(f"\n{len(errors)} integrity error(s)", file=sys.stderr)
        return 1
    n = sum(1 for _ in _iter_wiki_entries(root))
    print(f"OK: {n} wiki entries, frontmatter + links intact")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
