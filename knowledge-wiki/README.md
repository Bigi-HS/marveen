# LLM Knowledge-Wiki

A linked-markdown knowledge base for LLM concepts (card ab196f85, phase-1).
Index-based + full-text search, cheaper than vector embeddings, more precise
than flat vault FTS. No new dependencies: markdown + grep + YAML.

## Quick start

1. Open `index.md` and `Ctrl+F` (or `grep`) a keyword -> jump to the entry.
2. For anything not in the index: `grep -r "<term>" wiki/`.
3. `hot-cache.md` holds the highest-salience entries for quick session context.

## Layout

- `index.md` -- master TOC + full-text keyword map (every wiki entry is linked).
- `hot-cache.md` -- top-N entries for fast context priming.
- `wiki/` -- canonical, deduped, cross-linked entries (the curated knowledge).
- `sources/` -- raw input archive (research notes, transcripts); minimal edits.
- `FRONTMATTER_SCHEMA.md` -- the YAML schema every wiki entry must follow.
- `EDITORIAL_GUIDE.md` -- how raw sources become curated wiki entries.

## Integrity

`scripts/validate_knowledge_wiki.py` lints the tree: required frontmatter keys,
`related:`/`sources:` links resolve, and every `index.md` wiki-link points at a
real file. Run it before committing new entries:

```bash
python3 scripts/validate_knowledge_wiki.py knowledge-wiki
```

## Scope

Phase-1 ships the skeleton + ~10 generic example entries. Real curation
(Dominik notes, Big Ben transcripts) and programmatic tooling (auto-indexer,
SQLite overflow) are phase-2. The tracked tree carries NO private content;
real source notes are gitignored when they land in phase-2.
