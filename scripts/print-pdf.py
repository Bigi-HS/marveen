#!/usr/bin/env python3
"""
print-pdf.py -- markdown/frontmatter -> print-ready PDF (A4 flyer or A5 prospectus)

Usage:
  python3 scripts/print-pdf.py INPUT.md --template flyer-a4 --out OUTPUT.pdf
  python3 scripts/print-pdf.py INPUT.md --template prospectus-a5 --out OUTPUT.pdf
  python3 scripts/print-pdf.py --demo flyer-a4 --out /tmp/demo-flyer.pdf
  python3 scripts/print-pdf.py --demo prospectus-a5 --out /tmp/demo-prospectus.pdf

The markdown file may have a YAML frontmatter block (between --- delimiters) with
template variables. The markdown body becomes {{ body_html }}. All other {{ var }}
slots in the template are filled from frontmatter (missing ones become empty string).

Frontmatter for flyer-a4:
  title, subtitle, lead, organizer, date, location, image_hint, highlight_title,
  highlight_body, cta_text, cta_detail, cta_url, cta_label, contact_web,
  contact_email, contact_phone, footer_text

Frontmatter for prospectus-a5:
  title, subtitle, category, organizer, image_hint, image_caption, info_card_title,
  kp1_value, kp1_label, kp2_value, kp2_label, kp3_value, kp3_label,
  contact_web, contact_email, footer_text
  info_rows: list of {label, value} dicts (rendered as table rows)
"""

import argparse
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = REPO_ROOT / "scripts" / "templates"
DEMO_DIR = Path("/tmp")

DEMO_CONTENT = {
    "flyer-a4": {
        "title": "Kreatív Workshop 2026",
        "subtitle": "Tartalom, technika, közösség",
        "lead": "Egynapos intenziv workshop azoknak, akik a kreatív alkotást és a digitális tartalomgyártást egy helyen akarják megtanulni. Valódi projektek, valódi visszajelzés.",
        "organizer": "FlottaStudio",
        "date": "2026. október 15., csütörtök",
        "location": "Budapest, V. kerület",
        "image_hint": "1600x900px workshop fotó",
        "highlight_title": "Amit hazaviszel",
        "highlight_body": "Egy kész, publikálható tartalom-darab, a saját munkamódszered, és egy közösség aki segít továbblépni.",
        "cta_text": "Jelentkezz most -- 30 hely érhető el",
        "cta_detail": "Korai regisztráció: 2026. szeptember 30-ig",
        "cta_url": "#",
        "cta_label": "Regisztrálok",
        "contact_web": "flottastudio.hu",
        "contact_email": "hello@flottastudio.hu",
        "contact_phone": "+36 20 123 4567",
        "footer_text": "FlottaStudio -- Kreatív Workshop 2026 -- flottastudio.hu",
        "body": """## Program

**08:30** Érkezés, reggeli kávé

**09:00** Nyitó -- mi a jó tartalom?

**10:00** Videószerkesztés alapok (hands-on)

**12:00** Ebédszünet

**13:00** Fotóoptimalizálás és batch-feldolgozás

**14:30** Saját projekt sprint -- te alkotsz

**16:00** Közös visszajelzés és lezárás

## Kinek szól?

Tartalomgyártóknak, alkotóknak és kis vállalkozásoknak, akik profi minőséget akarnak elérni anélkül, hogy Canva-függők maradnának vagy drága ügynökséget fizetnének.

- Kezdők és haladók egyaránt
- Maximum 30 résztvevő -- intenzív, személyes
- Saját laptop/kamera szükséges
""",
    },
    "prospectus-a5": {
        "title": "FlottaStudio Szolgáltatások",
        "subtitle": "Videó, tartalom és digitális anyagok -- kód alapon, Canva nélkül",
        "category": "Szolgáltatási prospektus",
        "organizer": "FlottaStudio",
        "image_hint": "800x600px portré/logó",
        "image_caption": "Professzionális vizuális anyagok,\nkod-alapon.",
        "info_card_title": "Kapcsolat és idők",
        "kp1_value": "48h",
        "kp1_label": "Átlagos átfutási idő",
        "kp2_value": "100%",
        "kp2_label": "Nyomdakész kimenet",
        "kp3_value": "0 Ft",
        "kp3_label": "Canva előfizetés",
        "contact_web": "flottastudio.hu",
        "contact_email": "hello@flottastudio.hu",
        "footer_text": "FlottaStudio -- szolgáltatási prospektus 2026",
        "info_rows": [
            {"label": "Ajánlat érvényes:", "value": "2026. dec. 31."},
            {"label": "Fizetés:", "value": "Előre, átutalással"},
            {"label": "Revisio:", "value": "2 kör beleértve"},
            {"label": "Formátum:", "value": "MP4 / PDF / PNG"},
        ],
        "body": """## Mit csinálunk?

Videóvágás, motion graphics, nyomdakész flyer és prospektus, batch fényképoptimalizálás -- mind kód alapon, ismételhetően.

## Miért mi?

- Nincs Canva, nincs Adobe: minden szkriptelhető és reprodukálható
- Print-ready PDF: WeasyPrint nyomdai minőség
- Gyors iteráció: egy forrásfájl, tetszőleges kimenet

## Hogyan dolgozunk?

Rövid briefing, majd 48 órán belül első verzió. Két revíziókör benne van az árban. A végleges fájlok minden formátumban átadásra kerülnek.
""",
    },
}


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split YAML frontmatter from markdown body. Returns (vars_dict, body_md)."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    fm_block = text[3:end].strip()
    body = text[end + 4:].lstrip("\n")
    try:
        import yaml
        data = yaml.safe_load(fm_block) or {}
    except Exception:
        data = _simple_yaml_parse(fm_block)
    return data, body


def _simple_yaml_parse(text: str) -> dict:
    """Minimal YAML parser for key: value pairs (no yaml package fallback)."""
    result = {}
    current_list_key = None
    list_buffer = []
    for line in text.splitlines():
        if line.startswith("  - ") and current_list_key:
            list_buffer.append(line[4:].strip())
            continue
        if current_list_key:
            result[current_list_key] = list_buffer
            current_list_key = None
            list_buffer = []
        if ":" in line:
            k, _, v = line.partition(":")
            k = k.strip()
            v = v.strip()
            if v == "":
                current_list_key = k
            else:
                result[k] = v.strip('"').strip("'")
    if current_list_key and list_buffer:
        result[current_list_key] = list_buffer
    return result


def md_to_html(md_text: str) -> str:
    """Convert markdown to HTML using the python-markdown package."""
    import markdown as mdpkg
    return mdpkg.markdown(
        md_text,
        extensions=["tables", "fenced_code", "nl2br"],
    )


def build_info_rows_html(rows) -> str:
    """Build <tr> HTML from a list of {label, value} dicts."""
    if not rows:
        return ""
    parts = []
    for row in rows:
        if isinstance(row, dict):
            label = row.get("label", "")
            value = row.get("value", "")
        else:
            label, value = str(row), ""
        parts.append(
            f'<tr><td class="field-label">{label}</td><td>{value}</td></tr>'
        )
    return "\n".join(parts)


def fill_template(template_html: str, variables: dict) -> str:
    """Replace {{ var }} placeholders in the template with values from variables dict."""
    def replacer(m):
        key = m.group(1).strip()
        return str(variables.get(key, ""))
    return re.sub(r"\{\{\s*(\w+)\s*\}\}", replacer, template_html)


def render(template_name: str, variables: dict, output_path: Path) -> None:
    template_file = TEMPLATES_DIR / f"{template_name}.html"
    if not template_file.exists():
        sys.exit(f"Template not found: {template_file}")

    template_html = template_file.read_text(encoding="utf-8")
    filled_html = fill_template(template_html, variables)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        from weasyprint import HTML, CSS
        HTML(string=filled_html, base_url=str(REPO_ROOT)).write_pdf(
            str(output_path),
            presentational_hints=True,
        )
    except Exception as e:
        sys.exit(f"WeasyPrint error: {e}")

    size = output_path.stat().st_size
    print(f"OK: {output_path}  ({size // 1024} KB)")


def prepare_variables(fm: dict, body_md: str) -> dict:
    """Merge frontmatter + computed fields into a flat string dict for template filling."""
    v = {k: (str(v) if not isinstance(v, (list, dict)) else "") for k, v in fm.items()}

    # Body markdown -> HTML
    v["body_html"] = md_to_html(body_md) if body_md.strip() else fm.get("body_html", "")

    # info_rows special handling for prospectus
    raw_rows = fm.get("info_rows", [])
    v["info_rows_html"] = build_info_rows_html(raw_rows)

    # If body was in frontmatter as "body" key (used by demo), convert it
    if "body" in fm and not body_md.strip():
        v["body_html"] = md_to_html(fm["body"])

    return v


def main():
    parser = argparse.ArgumentParser(description="Markdown -> print-ready PDF (A4 flyer / A5 prospectus)")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("input", nargs="?", help="Input markdown file")
    group.add_argument("--demo", metavar="TEMPLATE", choices=list(DEMO_CONTENT.keys()),
                       help="Render a built-in demo (flyer-a4 | prospectus-a5)")
    parser.add_argument("--template", choices=["flyer-a4", "prospectus-a5"],
                        help="Template to use (required if not --demo)")
    parser.add_argument("--out", required=True, help="Output PDF path")
    args = parser.parse_args()

    out_path = Path(args.out)

    if args.demo:
        template_name = args.demo
        demo_fm = dict(DEMO_CONTENT[template_name])
        variables = prepare_variables(demo_fm, "")
    else:
        if not args.template:
            parser.error("--template is required when not using --demo")
        src = Path(args.input)
        if not src.exists():
            sys.exit(f"Input file not found: {src}")
        raw = src.read_text(encoding="utf-8")
        fm, body_md = parse_frontmatter(raw)
        variables = prepare_variables(fm, body_md)
        template_name = args.template

    render(template_name, variables, out_path)


if __name__ == "__main__":
    main()
