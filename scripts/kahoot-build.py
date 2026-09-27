#!/usr/bin/env python3
"""Kahoot quiz builder: dedup + limit gate + xlsx emit, chained to kahoot-finalize.py.

Why this exists: the same gate (dedup against previous quizzes, 120/75 char limits,
answer uniqueness) was rewritten three times in throwaway /tmp scripts. Card CONT-053.

Input: a JSON spec.
    {
      "title":     "Star Wars Kahoot",
      "out":       "store/kahoot-starwars.xlsx",
      "levels":    ["KONNYU", "KOZEPES", "NEHEZ"],        # optional, defines rising order
      "questions": [
        {"q": "...", "answers": ["a","b","c","d"], "correct": 1, "time": 20, "level": "KONNYU"}
      ]
    }
    `correct` is 1-based over the present answers.

Exit codes -- three states, and UNMEASURED never collapses into OK:
    0  gate passed, xlsx written
    1  MECHANICAL findings (limits, duplicates, malformed rows) -> no file written
    2  UNMEASURED: the run could not measure what it claims to (empty dedup corpus,
       control set fell over, unreadable input). This is NOT "clean".
    3  OUTPUT COLLISION: the target path already exists and this run did not create it.
       See ~/.claude/skills/shared-artifact-write-guard -- a generator that saves
       unconditionally to a shared store/ path can destroy a peer's delivered artifact.

Usage:
    python3 scripts/kahoot-build.py spec.json [--finalize] [--allow-overwrite]
"""

import json
import pathlib
import re
import subprocess
import sys
import unicodedata
from collections import Counter

REPO = pathlib.Path(__file__).resolve().parent.parent
BANK = REPO / "store" / "kahoot-question-bank.json"
CORPUS_GLOB = "store/kahoot-*.xlsx"

Q_LIMIT = 120          # Kahoot question character limit
A_LIMIT = 75           # Kahoot answer character limit
VALID_TIMES = {5, 10, 20, 30, 60, 90, 120, 240}
# Near-duplicate threshold. MEASURED 2026-08-14 on the live 398-question corpus (236 unique):
#   noise floor  -- of 8065 distinct-question pairs, p99 = 0.33, but 9 pairs land at or above 0.7.
#                   They are template siblings ("Mit szeret legjobban <nev> a LEGO Friendsben?"),
#                   i.e. real questions with different answers -> false alarms.
#   true positive -- a reworded duplicate (one word dropped) scores median 0.83, but 26 of 120
#                   fall BELOW 0.7, so this probe misses roughly a fifth of reworded duplicates.
# The two distributions overlap, so NO threshold separates them. That is why this is a WARN and
# never a hard fail, and why the run prints its own miss rate: an empty WARN list is a LOWER
# BOUND, not proof that no reworded duplicate got through. The hard gate is exact-match only.
NEAR_DUP_JACCARD = 0.7
NEAR_DUP_MEASURED_MISS = "26/120 (~22%) ujrafogalmazott duplikatum a kuszob ALATT marad [merve 08-14]"


# --- normalization ----------------------------------------------------------

def norm(s):
    """Accent-stripped, punctuation-free, whitespace-collapsed lowercase form."""
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def tokens(s):
    """Content tokens. Short words are dropped as noise, but ANY token containing a digit is
    kept regardless of length: version numbers and years survive normalization as 1-2 character
    fragments ("1.21.4" -> "1 21 4"), and dropping them made three different Minecraft-version
    questions score a perfect 1.00 against each other. [MERVE 08-14: the fix removes the 1.00
    collisions -- pairs >=0.9 go 3 -> 0 -- but they still sit at 0.86/0.86/0.75, so it does NOT
    clear the 0.7 threshold. I predicted it would; it did not.]
    """
    return {t for t in norm(s).split() if len(t) > 2 or any(c.isdigit() for c in t)}


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


# --- dedup corpus -----------------------------------------------------------

def load_corpus(exclude_path):
    """Every previously shipped question, from the bank JSON AND from the live xlsx files.

    The xlsx sweep matters: the bank is a snapshot and lags behind (the Star Wars quiz
    was on disk days before it reached the bank). Reading only the bank would let a
    freshly shipped quiz be re-shipped as "new".
    """
    corpus, sources = [], Counter()

    if BANK.exists():
        try:
            for e in json.loads(BANK.read_text(encoding="utf-8")):
                q = e.get("q")
                if q:
                    corpus.append((q, e.get("file", BANK.name)))
                    sources["bank"] += 1
        except (json.JSONDecodeError, OSError) as exc:
            print(f"  figyelem: a bank nem olvashato ({exc}) -- csak az xlsx-korpusz all")

    try:
        from openpyxl import load_workbook
    except ImportError:
        load_workbook = None
        print("  figyelem: nincs openpyxl -- az xlsx-korpusz kimarad")

    if load_workbook is not None:
        excl = pathlib.Path(exclude_path).resolve()
        for xlsx in sorted(REPO.glob(CORPUS_GLOB)):
            if xlsx.resolve() == excl:
                continue          # the target itself is not prior art
            try:
                ws = load_workbook(xlsx, read_only=True, data_only=True).active
                for row in list(ws.iter_rows(values_only=True))[1:]:
                    if row and row[0]:
                        corpus.append((str(row[0]), xlsx.name))
                        sources[xlsx.name] += 1
            except Exception as exc:                      # noqa: BLE001 - corrupt file must not be silent
                print(f"  figyelem: {xlsx.name} nem olvashato ({exc})")

    return corpus, sources


def build_index(corpus):
    exact = {}
    toks = []
    for q, src in corpus:
        exact.setdefault(norm(q), (q, src))
        toks.append((tokens(q), q, src))
    return exact, toks


def dup_of(question, exact, toks):
    """Return (kind, matched_question, source) or None."""
    n = norm(question)
    if n in exact:
        q, src = exact[n]
        return ("EGYEZES", q, src)
    t = tokens(question)
    best, bq, bsrc = 0.0, None, None
    for ct, cq, csrc in toks:
        j = jaccard(t, ct)
        if j > best:
            best, bq, bsrc = j, cq, csrc
    if best >= NEAR_DUP_JACCARD:
        return (f"KOZELI {best:.2f}", bq, bsrc)
    return None


# --- control set ------------------------------------------------------------

CTRL_CLEAN = "Melyik hangszeren jatszik a kvarcbanya fopincere csutortokonkent"


def controls_ok(exact, toks, corpus):
    """A dedup run is only interpretable if the corpus is actually loaded.

    Silent failure this catches: a wrong path or an empty bank makes EVERY question look
    new, and the run reports a clean green. The positive control is taken MECHANICALLY
    from the loaded corpus, so it cannot pass on an empty one.
    """
    problems = []
    if len(corpus) < 20:
        problems.append(f"a dedup-korpusz gyanusan kicsi ({len(corpus)} kerdes) -- nem mertem")
        return problems

    ctrl_dup = corpus[0][0]
    if dup_of(ctrl_dup, exact, toks) is None:
        problems.append(f"POZITIV KONTROLL BUKOTT: a korpusz sajat kerdeset nem ismerte fel duplikatumkent: {ctrl_dup!r}")
    if dup_of(CTRL_CLEAN, exact, toks) is not None:
        problems.append(f"NEGATIV KONTROLL BUKOTT: egy ertelmetlen kontroll-kerdes duplikatumnak minosult: {CTRL_CLEAN!r}")
    return problems


# --- output gate ------------------------------------------------------------

def claim(path, allow_overwrite):
    p = pathlib.Path(path)
    if p.exists() and not allow_overwrite:
        st = p.stat()
        print(f"\nUTKOZES: a cel MAR LETEZIK: {p} ({st.st_size} byte)")
        print("NEM irom felul -- lehet egy masik agens mar leszallitott artefaktuma.")
        print(f"Javasolt: masik nev, vagy --allow-overwrite ha bizonyitottan a tied.")
        sys.exit(3)
    return p


# --- validation -------------------------------------------------------------

def validate(questions, exact, toks):
    errs, warns = [], []
    seen_in_spec = {}

    for i, item in enumerate(questions, 1):
        q = (item.get("q") or "").strip()
        answers = [str(a).strip() for a in (item.get("answers") or []) if str(a).strip()]
        correct = item.get("correct")
        time = item.get("time", 20)

        if not q:
            errs.append(f"#{i}: ures kerdes")
            continue
        if len(q) > Q_LIMIT:
            errs.append(f"#{i}: kerdes {len(q)} karakter (limit {Q_LIMIT}): {q[:60]}...")
        if not 2 <= len(answers) <= 4:
            errs.append(f"#{i}: {len(answers)} valasz (2-4 kell)")
            continue
        for a in answers:
            if len(a) > A_LIMIT:
                errs.append(f"#{i}: valasz {len(a)} karakter (limit {A_LIMIT}): {a[:50]}...")
        if len({norm(a) for a in answers}) != len(answers):
            errs.append(f"#{i}: azonos valaszok egy kerdesen belul")
        if not isinstance(correct, int) or not 1 <= correct <= len(answers):
            errs.append(f"#{i}: correct={correct!r} nem ervenyes index (1..{len(answers)})")
        if time not in VALID_TIMES:
            errs.append(f"#{i}: time={time} nem Kahoot-ertek {sorted(VALID_TIMES)}")

        n = norm(q)
        if n in seen_in_spec:
            errs.append(f"#{i}: a specen BELUL duplikalt kerdes (#{seen_in_spec[n]}): {q[:60]}")
        seen_in_spec[n] = i

        hit = dup_of(q, exact, toks)
        if hit:
            kind, matched, src = hit
            (errs if kind == "EGYEZES" else warns).append(
                f"#{i}: DUPLIKATUM [{kind}] <- {src}: {matched[:70]}\n      uj: {q[:70]}")

    return errs, warns


def level_report(questions, levels):
    got = [str(q.get("level") or "?") for q in questions]
    counts = Counter(got)
    print("\n--- szint-eloszlas ---")
    for lv in (levels or sorted(counts)):
        print(f"  {lv:<10} {counts.get(lv, 0)}")
    unknown = [lv for lv in counts if levels and lv not in levels]
    if unknown:
        print(f"  ISMERETLEN szintek: {unknown}")
    if levels:
        order = {lv: i for i, lv in enumerate(levels)}
        seq = [order.get(lv, -1) for lv in got]
        drops = [i + 1 for i in range(1, len(seq)) if seq[i] < seq[i - 1]]
        if drops:
            print(f"  FIGYELEM: a nehezseg nem monoton emelkedo, visszalepes itt: {drops}")
        else:
            print("  a nehezseg monoton emelkedo")


# --- emit -------------------------------------------------------------------

def write_xlsx(path, questions):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Kahoot"
    ws.append(["Question", "Answer 1", "Answer 2", "Answer 3", "Answer 4",
               "Time limit (sec)", "Correct answer(s)"])
    for item in questions:
        answers = [str(a).strip() for a in item["answers"] if str(a).strip()]
        answers += [None] * (4 - len(answers))
        ws.append([item["q"].strip(), *answers, item.get("time", 20), str(item["correct"])])
    ws.column_dimensions["A"].width = 60
    for col in "BCDE":
        ws.column_dimensions[col].width = 34
    wb.save(path)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if not args:
        print(__doc__)
        sys.exit(2)

    spec_path = pathlib.Path(args[0])
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"NEM MERT: a spec nem olvashato: {exc}")
        sys.exit(2)

    questions = spec.get("questions") or []
    out = spec.get("out")
    if not questions or not out:
        print("NEM MERT: a spec 'questions' vagy 'out' mezoje hianyzik")
        sys.exit(2)

    print(f"=== KAHOOT BUILD: {spec.get('title', spec_path.stem)} ({len(questions)} kerdes) ===")

    print("\n--- dedup-korpusz ---")
    corpus, sources = load_corpus(out)
    print(f"  {len(corpus)} korabbi kerdes, {len(sources)} forrasbol")
    exact, toks = build_index(corpus)

    problems = controls_ok(exact, toks, corpus)
    if problems:
        print("\nERVENYTELEN FUTAS -- a kontroll-keszlet elesett:")
        for p in problems:
            print("  " + p)
        print("A 'nincs duplikatum' eredmeny NEM ertelmezheto. Ez nem tiszta, hanem MERETLEN.")
        sys.exit(2)
    print("  kontroll-keszlet: OK (ismert duplikatum elkapva, ismert tiszta atengedve)")

    errs, warns = validate(questions, exact, toks)
    level_report(questions, spec.get("levels"))

    print(f"\n--- KOZELI egyezes: {len(warns)} talalat (emberi dontes, nem blokkol) ---")
    print(f"  FIGYELEM, a szonda MERT korlatja: {NEAR_DUP_MEASURED_MISS}.")
    print("  Tehat a 0 talalat ALSO KORLAT, nem bizonyitek arra hogy nincs atfogalmazott duplikatum.")
    for w in warns:
        print("  " + w)

    if errs:
        print(f"\n=== KAPU: BUKOTT -- {len(errs)} hiba, NINCS FAJL ===")
        for e in errs:
            print("  " + e)
        sys.exit(1)

    # the collision check runs BEFORE the green line, so a blocked run never shows a pass banner
    target = claim(out, "--allow-overwrite" in flags)
    print("\n=== KAPU: ATMENT ===")
    write_xlsx(target, questions)
    print(f"XLSX: {target}")

    if "--finalize" in flags:
        # the file was created by THIS run, so the in-place rewrite is ours to make
        fin = REPO / "scripts" / "kahoot-finalize.py"
        rc = subprocess.run(
            [sys.executable, str(fin), str(target), str(target.with_suffix(".pdf")),
             spec.get("title", "Kahoot Kviz")],
            cwd=REPO).returncode
        if rc != 0:
            print(f"FIGYELEM: a finalize bukott (rc={rc}) -- az xlsx megvan, a PDF/pozicio-kiegyensulyozas nem")
            sys.exit(1)


if __name__ == "__main__":
    main()
