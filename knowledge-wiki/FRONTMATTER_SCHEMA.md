# Wiki Entry Frontmatter Schema

Every file under `wiki/` begins with a YAML frontmatter block fenced by `---`.

```yaml
---
title: "Human-readable entry title"          # REQUIRED, string
keywords: "comma, separated, search, terms"  # REQUIRED, string (drives index.md)
sources:                                      # OPTIONAL, list of paths under sources/
  - "sources/dominik-research-notes/2026-06-01-transformer-internals.md"
related:                                      # REQUIRED, list (use [] if none yet)
  - "wiki/foundations/attention-mechanism.md"
created_at: 2026-06-16                        # REQUIRED, ISO date
updated_at: 2026-06-16                        # REQUIRED, ISO date
---
```

## Rules

- **Paths are relative to the wiki root** (`knowledge-wiki/`), e.g.
  `wiki/foundations/attention-mechanism.md`, not `../foundations/...`.
- `related:` targets MUST resolve to existing wiki entries (validator enforces).
- `sources:` is optional; if present each entry MUST live under `sources/` and
  exist (validator enforces). Omit the field entirely when there is no source.
- `keywords` feeds the `index.md` keyword map; keep them lowercase, specific,
  and free of duplication across unrelated entries (precision over recall).
- Update `updated_at` on every content edit; keep `created_at` immutable.

## Required keys

`title`, `keywords`, `related`, `created_at`, `updated_at`. Missing any -> the
validator fails the entry.
