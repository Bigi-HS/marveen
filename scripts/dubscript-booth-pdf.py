#!/usr/bin/env python3
"""
dubscript-booth-pdf.py -- Per-character booth (recording) PDF export.

Derives the studio booth view from the 16-column dubbing master CSV. The booth
view is a NARROWED, REORDERED projection of the editorial master (spec:
store/dubscript-booth-view-spec.md, Radar v2): one PDF per character, only that
character's lines, in the actor's reading order with large Hungarian text and
colour-coded KAM badges. The English source and the reviewer notes are dropped.

Input:  the 16-column template CSV (per store/dubscript-template-v1.md):
        GLOBAL_ID, #, TC_IN, TC_OUT, DUR, KAMERA, KARAKTER, SZOT_HU, SZOT_EN,
        MAGYAR_SZOVEG, DIREKCIO, INT, KIEJTES, ANGOL_SZOVEG, FORD_MEGJEGYZES, TAKE
Output: one PDF per character: <outdir>/<episode>_<Character>_booth.pdf

Usage:
    python3 dubscript-booth-pdf.py \
        --csv store/spaceking-ep1/spaceking-ep1-template-v1.csv \
        --outdir store/spaceking-ep1/booth \
        --episode EP01 [--character Kapitany]
"""

import argparse
import csv
import os
import sys
import unicodedata


# ── Pure logic (unit-tested) ──────────────────────────────────────────────────

# KAM badge -> (display label, hex colour). v2 enum (spec section v2):
#   ON-KEY = strict lip-flap match (dark red), ON-STD = start/end match (red),
#   OC = off-camera (yellow), OFF = voiceover/free rhythm (grey),
#   TEXT = on-screen readable dialog (blue). Bare "ON" maps to ON-STD (legacy).
KAM_BADGE = {
    "ON-KEY": ("ON-KEY", "8B0000"),
    "ON-STD": ("ON-STD", "FF0000"),
    "ON": ("ON", "FF0000"),
    "OC": ("OC", "FFD700"),
    "OFF": ("OFF", "B0B0B0"),
    "TEXT": ("TEXT", "1E90FF"),
}

# Per-character row tint (pastel). Falls back to white for unknown characters.
CHAR_COLORS = {
    "Kapitány": "BDD7EE", "Dühöngő": "FCE4D6", "Bryce": "E2EFDA",
    "Mogyi": "EAD1DC", "Marine": "FFF2CC", "Koponya": "D9D9D9",
    "Pók": "F4CCCC", "Robothang": "CFE2F3", "Űrkirály": "D9EAD3",
    "_default": "FFFFFF",
}

# ON-family (lip-sync constraint applies) for the syllable-overflow warning.
_ON_FAMILY = {"ON", "ON-KEY", "ON-STD"}

# Markup legend printed in each booth-PDF header (spec section "Markup-legenda").
MARKUP_LEGEND = [
    "[szo] = opcionalis/vaghato   (horog)(sohajt) = paralingvisztika, nem kimondando",
    "ALT: = alternativ megfogalmazas   * Brajsz * = fonetikus kiejtes (elso elofordulas)",
    "/ = rovid legzes  // = hosszabb szunet   -- = megszakitas  ... = elhalas",
    "alahuzott magyar sor = OFF (kepen kivuli)",
]


def kam_badge(kamera):
    """Return (label, hex_colour) for a KAMERA value, or None when empty/unknown.
    Case-insensitive; surrounding whitespace tolerated."""
    key = (kamera or "").strip().upper()
    return KAM_BADGE.get(key)


def is_off(kamera):
    """True for an OFF (voiceover / off-screen) line -> underline the HU text."""
    return (kamera or "").strip().upper() == "OFF"


def _to_int(value):
    try:
        return int(str(value).strip() or 0)
    except (TypeError, ValueError):
        return 0


def syllable_overflow(szot_hu, szot_en, kamera, threshold=0.20):
    """True when an ON-family line's HU syllable count diverges from the EN
    source by more than `threshold` (default 20%) -> the HOSSZ cell turns red
    (lip-sync warning, mirrors the master's conditional formatting). Non-ON
    lines have free rhythm, so they never warn."""
    if (kamera or "").strip().upper() not in _ON_FAMILY:
        return False
    hu, en = _to_int(szot_hu), _to_int(szot_en)
    if en <= 0:
        return False
    return abs(hu - en) / en > threshold


def split_characters(karakter_field):
    """Split a KARAKTER cell into individual character names. A shared line
    ('Kapitany, Mogyi, Bryce') belongs to each named character."""
    return [c.strip() for c in (karakter_field or "").split(",") if c.strip()]


def char_matches(karakter_field, character):
    """True when `character` is one of the (possibly several) speakers of a row."""
    return character in split_characters(karakter_field)


def distinct_characters(rows):
    """All individual character names across the script, sorted, deduped."""
    seen = set()
    for row in rows:
        seen.update(split_characters(row.get("KARAKTER", "")))
    return sorted(seen)


def rows_for_character(rows, character):
    """Only the rows `character` speaks, original order preserved."""
    return [r for r in rows if char_matches(r.get("KARAKTER", ""), character)]


def ascii_fold(text):
    """Fold accents to ASCII and keep only filename-safe chars (for delivery
    filenames and PDF names): 'Kapitany', 'Urkiraly'."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return "".join(c if (c.isalnum() or c in "-_") else "_" for c in stripped)


def delivery_filename(episode, global_id, character):
    """Per-line audio delivery name from the GLOBAL_ID (game-VO convention,
    spec section v2.4): EP01 + S01-003 + Kapitany -> EP01_S01_003_Kapitany.wav.
    Gives the booth export and the recorded audio a shared namespace."""
    gid = (global_id or "").strip().replace("-", "_").replace(" ", "")
    return "{}_{}_{}.wav".format(episode, gid, ascii_fold(character))


def booth_pdf_name(episode, character):
    """Per-character booth-PDF filename: EP01_Kapitany_booth.pdf."""
    return "{}_{}_booth.pdf".format(episode, ascii_fold(character))


def char_color(character):
    return CHAR_COLORS.get(character, CHAR_COLORS["_default"])


# ── PDF rendering (reportlab) ─────────────────────────────────────────────────

def _require_reportlab():
    try:
        import reportlab  # noqa: F401
    except ImportError:
        print("ERROR: reportlab not installed. Run: pip install reportlab", file=sys.stderr)
        sys.exit(1)


def build_booth_pdf(rows, character, episode, out_path):
    """Render one character's booth PDF. `rows` is the FULL list of CSV dict
    rows; this filters to `character`. Returns the number of lines rendered."""
    _require_reportlab()
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import (
        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer,
    )

    char_rows = rows_for_character(rows, character)

    styles = getSampleStyleSheet()
    title_style = styles["Title"]
    legend_style = ParagraphStyle("legend", parent=styles["Normal"], fontSize=7, leading=9, textColor=colors.HexColor("#555555"))
    hu_style = ParagraphStyle("hu", parent=styles["Normal"], fontSize=15, leading=18)
    hu_off_style = ParagraphStyle("hu_off", parent=hu_style, underlineWidth=0.6)
    kiejtes_style = ParagraphStyle("kiejtes", parent=styles["Normal"], fontSize=8, leading=10, textColor=colors.HexColor("#777777"), italic=True)
    dir_style = ParagraphStyle("dir", parent=styles["Normal"], fontSize=9, leading=11, textColor=colors.HexColor("#333333"))
    small_style = ParagraphStyle("small", parent=styles["Normal"], fontSize=8, leading=10)

    def esc(text):
        return (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    header = ["ID", "TC", "KAM", "HOSSZ", "DIREKCIO", "MAGYAR SOR", "ALT", "TAKE"]
    data = [header]
    style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#4472C4")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, 0), 8),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CCCCCC")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#" + char_color(character)), colors.white]),
    ]

    for i, row in enumerate(char_rows, start=1):
        kamera = row.get("KAMERA", "")
        badge = kam_badge(kamera)
        kam_label = badge[0] if badge else ""
        hu_text = esc(row.get("MAGYAR_SZOVEG", ""))
        kiejtes = row.get("KIEJTES", "").strip()
        hu_para_style = hu_off_style if is_off(kamera) else hu_style
        if is_off(kamera) and hu_text:
            hu_text = "<u>{}</u>".format(hu_text)
        hu_cell = [Paragraph(hu_text, hu_para_style)]
        if kiejtes:
            hu_cell.append(Paragraph("*{}*".format(esc(kiejtes)), kiejtes_style))

        # ALT: only the alternative phrasing portion of FORD_MEGJEGYZES (the
        # "ALT: ..." prefix), never the full reviewer debate.
        ford = row.get("FORD_MEGJEGYZES", "")
        alt = ""
        for piece in ford.split("\n"):
            if piece.strip().upper().startswith("ALT:"):
                alt = piece.strip()[4:].strip()
                break

        tc = row.get("TC_IN", "")
        tc_out = row.get("TC_OUT", "")
        tc_cell = Paragraph("{}<br/><font size=6 color='#999999'>{}</font>".format(esc(tc), esc(tc_out)), small_style)

        data.append([
            Paragraph(esc(row.get("GLOBAL_ID", "")), small_style),
            tc_cell,
            Paragraph(esc(kam_label), small_style),
            Paragraph(esc(row.get("DUR", "")), small_style),
            Paragraph(esc(row.get("DIREKCIO", "")), dir_style),
            hu_cell,
            Paragraph(esc(alt), small_style),
            Paragraph(esc(row.get("TAKE", "")), small_style),
        ])

        rownum = i  # 1-based data row index in the table
        # KAM badge colour
        if badge:
            style_cmds.append(("BACKGROUND", (2, rownum), (2, rownum), colors.HexColor("#" + badge[1])))
            text_col = colors.white if badge[1] in ("8B0000", "FF0000", "1E90FF") else colors.black
            style_cmds.append(("TEXTCOLOR", (2, rownum), (2, rownum), text_col))
        # Syllable-overflow -> red HOSSZ cell
        if syllable_overflow(row.get("SZOT_HU"), row.get("SZOT_EN"), kamera):
            style_cmds.append(("BACKGROUND", (3, rownum), (3, rownum), colors.HexColor("#FF9999")))
        # RETAKE -> yellow stripe across the row
        if row.get("TAKE", "").strip().upper() == "RETAKE":
            style_cmds.append(("BACKGROUND", (0, rownum), (-1, rownum), colors.HexColor("#FFF2CC")))

    # Column widths (mm). MAGYAR SOR is the widest (the only continuously-read
    # field); ALT gets the remainder. Fits A4 portrait (190mm usable).
    col_widths = [16 * mm, 20 * mm, 16 * mm, 14 * mm, 32 * mm, 62 * mm, 26 * mm, 14 * mm]

    doc = SimpleDocTemplate(
        out_path, pagesize=A4,
        leftMargin=10 * mm, rightMargin=10 * mm, topMargin=12 * mm, bottomMargin=10 * mm,
        title="{} booth -- {}".format(episode, character),
    )
    flow = [
        Paragraph("{} -- Booth: {}".format(esc(episode), esc(character)), title_style),
        Paragraph("{} sor. Delivery-nev minta: {}".format(
            len(char_rows),
            delivery_filename(episode, char_rows[0].get("GLOBAL_ID", "") if char_rows else "S00-000", character),
        ), small_style),
        Spacer(1, 3 * mm),
    ]
    for line in MARKUP_LEGEND:
        flow.append(Paragraph(esc(line), legend_style))
    flow.append(Spacer(1, 4 * mm))

    table = Table(data, colWidths=col_widths, repeatRows=1)
    table.setStyle(TableStyle(style_cmds))
    flow.append(table)
    doc.build(flow)
    return len(char_rows)


def load_rows(csv_path):
    with open(csv_path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Per-character booth PDF export.")
    ap.add_argument("--csv", required=True, help="16-column template CSV")
    ap.add_argument("--outdir", required=True, help="output directory for the PDFs")
    ap.add_argument("--episode", default="EP01", help="episode tag for filenames (default EP01)")
    ap.add_argument("--character", default=None, help="export only this character (default: all)")
    args = ap.parse_args(argv)

    rows = load_rows(args.csv)
    os.makedirs(args.outdir, exist_ok=True)

    targets = [args.character] if args.character else distinct_characters(rows)
    written = 0
    for character in targets:
        char_rows = rows_for_character(rows, character)
        if not char_rows:
            print("  skip {} (0 lines)".format(character), file=sys.stderr)
            continue
        out_path = os.path.join(args.outdir, booth_pdf_name(args.episode, character))
        n = build_booth_pdf(rows, character, args.episode, out_path)
        print("  {} -> {} ({} lines)".format(character, out_path, n))
        written += 1
    print("Wrote {} booth PDF(s) to {}".format(written, args.outdir))
    return 0


if __name__ == "__main__":
    sys.exit(main())
