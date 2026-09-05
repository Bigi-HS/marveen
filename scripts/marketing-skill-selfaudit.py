#!/usr/bin/env python3
"""marketing-skill-selfaudit.py -- drift linter for the marketing/YT skill cluster.

Card 4c5a7005 sibling deliverable (Grace/radar, 07-30 weekly dream). After the
consolidation (marketing-router + planned overlap-merge) the cluster can drift in
two ways this linter catches:

  1. STRUCTURAL (ERROR, exit 1): a cluster skill dir has gone missing -- e.g. an
     overlap-merge deleted a skill the router or a sibling still points to.
  2. baked-numbers drift (WARN): a skill that PLEDGES the "zero algorithm numbers,
     pull live" rule (youtube-full, content-repurposing-funnel, ...) now contains a
     hardcoded algorithm metric (CTR / retention / length / cadence / subscriber #).
  3. dangling refs (WARN): a [[wikilink]] or a backticked kebab skill-ref that does
     not resolve to a global skill dir (may be a to-be-written stub, so advisory).

Read-only. Exit non-zero only on a STRUCTURAL error, so it is CI-safe as a gate
for "did a merge delete a still-referenced skill" while staying advisory on style.

Usage: python3 scripts/marketing-skill-selfaudit.py [--skills-dir DIR]
"""
import os
import re
import sys

DEFAULT_SKILLS_DIR = os.path.expanduser("~/.claude/skills")

# The marketing / YT / Twitch / Discord cluster (card 4c5a7005 inventory + router + brand).
CLUSTER = [
    "youtube-full", "youtube-blue-ocean", "claude-youtube", "youtube-channel-setup",
    "content-strategy", "content-creator-production", "content-repurposing-funnel",
    "video-content-strategist", "twitch-discord-growth", "social-media-manager",
    "marketing-ideas", "marketing-router", "brand-guidelines", "brand-name-availability",
]

# A skill pledges the zero-numbers rule if any marker appears (case-insensitive).
ZERO_NUM_MARKERS = [
    "zero algorithm number", "zero-numbers", "zero numbers", "holds no number",
    "never baked", "no baked", "fetched fresh", "date-filtered websearch",
    "pull live", "pull the current", "nincs szám", "never hardcode", "no numbers after",
]

# Algorithm-metric drift: a digit sitting close to a metric keyword.
_METRIC = (r"ctr|retention|watch[- ]?time|subscribers?|feliratkoz|minutes?|seconds?|"
           r"m[aá]sodperc|\bperc\b|\bmp\b|per week|/week|per day|posts? per|uploads? per")
DIGIT_NEAR_METRIC = re.compile(
    r"(?:\d[\d.,]*\s*%?\s*\S{0,10}?(?:" + _METRIC + r"))"
    r"|(?:(?:" + _METRIC + r")\S{0,10}?\s*\d[\d.,]*\s*%?)",
    re.IGNORECASE,
)
# Ignore obvious non-metric digits on a flagged line (years, tiers, ids, urls, ranges).
NOISE = re.compile(r"20\d\d|tier[- ]?\d|\b\d{5,}\b|https?://", re.IGNORECASE)

WIKILINK = re.compile(r"\[\[([a-z0-9][a-z0-9-]{2,})\]\]")
BACKTICK_SLUG = re.compile(r"`([a-z0-9]+(?:-[a-z0-9]+){1,})`")


def read(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def main():
    skills_dir = DEFAULT_SKILLS_DIR
    if "--skills-dir" in sys.argv:
        skills_dir = sys.argv[sys.argv.index("--skills-dir") + 1]

    def resolves(name):
        return os.path.isfile(os.path.join(skills_dir, name, "SKILL.md"))

    errors, warns = [], []

    # Check 1: structural integrity of the cluster.
    for name in CLUSTER:
        if not resolves(name):
            errors.append("MISSING cluster skill: %s (dir/SKILL.md absent under %s)"
                          % (name, skills_dir))

    # Checks 2 + 3: per-skill content drift + dangling refs.
    for name in CLUSTER:
        path = os.path.join(skills_dir, name, "SKILL.md")
        if not os.path.isfile(path):
            continue
        text = read(path)
        low = text.lower()
        pledged = any(m in low for m in ZERO_NUM_MARKERS)
        for i, line in enumerate(text.splitlines(), 1):
            if pledged and DIGIT_NEAR_METRIC.search(line) and not NOISE.search(line):
                warns.append("%s:%d baked-number drift (zero-numbers skill): %s"
                             % (name, i, line.strip()[:100]))
            for ref in WIKILINK.findall(line):
                if not resolves(ref):
                    warns.append("%s:%d dangling [[%s]] (no such skill)" % (name, i, ref))
            for ref in BACKTICK_SLUG.findall(line):
                if ref in CLUSTER or resolves(ref):
                    continue
                # only flag backtick slugs that look like a skill ref (routing context)
                if re.search(r"route|load|owner|->|specialist|skill", line, re.IGNORECASE):
                    warns.append("%s:%d unresolved skill-ref `%s`" % (name, i, ref))

    print("=== marketing-skill self-audit ===")
    print("cluster size: %d | skills-dir: %s" % (len(CLUSTER), skills_dir))
    print("ERRORS: %d | WARNINGS: %d\n" % (len(errors), len(warns)))
    for e in errors:
        print("  ERROR  " + e)
    for w in warns:
        print("  WARN   " + w)
    if not errors and not warns:
        print("  clean -- no drift detected.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
