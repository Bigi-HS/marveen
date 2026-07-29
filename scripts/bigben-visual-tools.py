#!/usr/bin/env python3
"""BigBen visual tools -- clean-room implementation (card 47476c28).

Two generators:
  diagram   -- boxes-and-arrows architecture/flow diagram (Pillow only)
  code      -- syntax-highlighted code image (Pillow + pygments)

CLI:
  python3 bigben-visual-tools.py diagram --out out.png --json '{"boxes":[...],"arrows":[...]}'
  python3 bigben-visual-tools.py code --lang python --out out.png --code 'x = 1'
  python3 bigben-visual-tools.py code --lang python --out out.png  # reads stdin
  python3 bigben-visual-tools.py diagram --demo --out demo.png

Python API:
  from scripts.bigben_visual_tools import make_diagram, make_code_image
  make_diagram(boxes, arrows, "out.png")
  make_code_image(code, "python", "out.png")
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import textwrap
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Diagram generator
# ---------------------------------------------------------------------------

def make_diagram(
    boxes: list[dict],
    arrows: list[dict],
    output_path: str,
    width: int = 1280,
    height: int = 720,
    bg_color: str = "#0f1117",
    box_color: str = "#1e2130",
    box_border: str = "#3a4060",
    text_color: str = "#e8eaf0",
    arrow_color: str = "#4a6fa5",
    accent_color: str = "#00d4ff",
    font_size: int = 22,
) -> str:
    """Render a box-and-arrow diagram to a PNG.

    boxes: [{"label": str, "row": int, "col": int}, ...]
           row/col are grid coordinates (0-indexed). If omitted, auto-laid out.
    arrows: [{"from": str, "to": str, "label": str (optional)}, ...]
    Returns output_path.
    """
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (width, height), bg_color)
    draw = ImageDraw.Draw(img)

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
        font_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", max(12, font_size - 6))
    except OSError:
        font = ImageFont.load_default()
        font_small = font

    if not boxes:
        raise ValueError("make_diagram: boxes list is empty")

    # --- auto-layout if row/col missing ---
    need_layout = any("row" not in b or "col" not in b for b in boxes)
    if need_layout:
        cols = max(1, math.ceil(math.sqrt(len(boxes))))
        for i, b in enumerate(boxes):
            if "row" not in b:
                b["row"] = i // cols
            if "col" not in b:
                b["col"] = i % cols

    max_row = max(b["row"] for b in boxes) + 1
    max_col = max(b["col"] for b in boxes) + 1

    # --- cell sizing ---
    pad_x, pad_y = 60, 50
    cell_w = (width - 2 * pad_x) / max_col
    cell_h = (height - 2 * pad_y) / max_row
    box_w = int(cell_w * 0.72)
    box_h = int(cell_h * 0.52)

    def cell_center(row: int, col: int) -> tuple[int, int]:
        cx = int(pad_x + col * cell_w + cell_w / 2)
        cy = int(pad_y + row * cell_h + cell_h / 2)
        return cx, cy

    def box_rect(row: int, col: int) -> tuple[int, int, int, int]:
        cx, cy = cell_center(row, col)
        x0 = cx - box_w // 2
        y0 = cy - box_h // 2
        return x0, y0, x0 + box_w, y0 + box_h

    box_positions: dict[str, tuple[int, int, int, int]] = {}
    for b in boxes:
        box_positions[b["label"]] = box_rect(b["row"], b["col"])

    # --- draw arrows first (behind boxes) ---
    for arrow in arrows:
        src_label = arrow.get("from", "")
        dst_label = arrow.get("to", "")
        if src_label not in box_positions or dst_label not in box_positions:
            continue
        x0, y0, x1, y1 = box_positions[src_label]
        ax0, ay0, ax1, ay1 = box_positions[dst_label]

        src_cx, src_cy = (x0 + x1) // 2, (y0 + y1) // 2
        dst_cx, dst_cy = (ax0 + ax1) // 2, (ay0 + ay1) // 2

        # Exit from bottom of src if dst is below, else from right
        dy = dst_cy - src_cy
        dx = dst_cx - src_cx
        if abs(dy) >= abs(dx):
            start = (src_cx, y1 if dy > 0 else y0)
            end = (dst_cx, ay0 if dy > 0 else ay1)
        else:
            start = (x1 if dx > 0 else x0, src_cy)
            end = (ax0 if dx > 0 else ax1, dst_cy)

        draw.line([start, end], fill=arrow_color, width=2)
        # Arrowhead
        _draw_arrowhead(draw, start, end, arrow_color, size=10)

        label = arrow.get("label", "")
        if label:
            mid = ((start[0] + end[0]) // 2, (start[1] + end[1]) // 2 - 10)
            draw.text(mid, label, font=font_small, fill=arrow_color, anchor="mm")

    # --- draw boxes ---
    radius = 8
    for b in boxes:
        rect = box_positions[b["label"]]
        x0, y0, x1, y1 = rect
        _rounded_rect(draw, rect, radius, box_color, box_border, border_width=2)
        label = b["label"]
        lines = textwrap.wrap(label, width=max(8, box_w // (font_size // 2)))
        line_h = font_size + 4
        total_h = len(lines) * line_h
        ty = (y0 + y1) // 2 - total_h // 2
        for line in lines:
            draw.text(((x0 + x1) // 2, ty + line_h // 2), line, font=font, fill=text_color, anchor="mm")
            ty += line_h

    img.save(output_path, "PNG")
    return output_path


def _draw_arrowhead(draw, start: tuple, end: tuple, color: str, size: int = 10):
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = math.hypot(dx, dy)
    if length < 1:
        return
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    tip = end
    b1 = (int(tip[0] - size * ux + size * 0.4 * px), int(tip[1] - size * uy + size * 0.4 * py))
    b2 = (int(tip[0] - size * ux - size * 0.4 * px), int(tip[1] - size * uy - size * 0.4 * py))
    draw.polygon([tip, b1, b2], fill=color)


def _rounded_rect(draw, rect, radius, fill, outline, border_width=2):
    x0, y0, x1, y1 = rect
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill, outline=outline, width=border_width)


# ---------------------------------------------------------------------------
# Code snippet generator
# ---------------------------------------------------------------------------

THEMES = {
    "monokai": {
        "bg": "#272822", "default": "#f8f8f2",
        "keyword": "#f92672", "string": "#e6db74", "comment": "#75715e",
        "number": "#ae81ff", "function": "#a6e22e", "operator": "#f8f8f2",
        "class": "#a6e22e", "decorator": "#a6e22e", "type": "#66d9ef",
    },
    "dark": {
        "bg": "#1e1e1e", "default": "#d4d4d4",
        "keyword": "#569cd6", "string": "#ce9178", "comment": "#6a9955",
        "number": "#b5cea8", "function": "#dcdcaa", "operator": "#d4d4d4",
        "class": "#4ec9b0", "decorator": "#dcdcaa", "type": "#4ec9b0",
    },
    "solarized": {
        "bg": "#002b36", "default": "#839496",
        "keyword": "#859900", "string": "#2aa198", "comment": "#586e75",
        "number": "#d33682", "function": "#268bd2", "operator": "#839496",
        "class": "#b58900", "decorator": "#cb4b16", "type": "#268bd2",
    },
}

def _pygments_token_to_role(token_type) -> str:
    """Map a pygments token type to one of our theme roles."""
    from pygments import token as T
    if token_type in T.Keyword or token_type in T.Keyword.Type:
        return "keyword"
    if token_type in T.Literal.String or token_type in T.String:
        return "string"
    if token_type in T.Comment:
        return "comment"
    if token_type in T.Literal.Number or token_type in T.Number:
        return "number"
    if token_type in T.Name.Function or token_type in T.Name.Function.Magic:
        return "function"
    if token_type in T.Name.Class:
        return "class"
    if token_type in T.Name.Decorator:
        return "decorator"
    if token_type in T.Name.Builtin.Pseudo or token_type in T.Name.Builtin:
        return "type"
    if token_type in T.Operator or token_type in T.Punctuation:
        return "operator"
    return "default"


def make_code_image(
    code: str,
    language: str = "python",
    output_path: str = "code.png",
    theme: str = "monokai",
    width: int = 1280,
    font_size: int = 22,
    padding: int = 48,
    line_numbers: bool = True,
) -> str:
    """Render syntax-highlighted code to a PNG.

    Returns output_path.
    """
    from PIL import Image, ImageDraw, ImageFont
    import pygments
    from pygments import lexers, token as T

    colors = THEMES.get(theme, THEMES["monokai"])

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", font_size)
        font_ln = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", max(12, font_size - 4))
    except OSError:
        font = ImageFont.load_default()
        font_ln = font

    line_height = font_size + 6
    char_w = font_size * 0.60

    lines = code.rstrip().splitlines()
    n_lines = len(lines)
    max_chars = max((len(l) for l in lines), default=40)
    ln_width = (len(str(n_lines)) + 2) * int(char_w) if line_numbers else 0
    content_w = max(width - 2 * padding - ln_width, int(max_chars * char_w) + 20)
    img_width = max(width, 2 * padding + ln_width + content_w)
    img_height = 2 * padding + n_lines * line_height

    img = Image.new("RGB", (img_width, img_height), colors["bg"])
    draw = ImageDraw.Draw(img)

    # Tokenize
    try:
        lexer = lexers.get_lexer_by_name(language, stripall=False)
    except pygments.util.ClassNotFound:
        lexer = lexers.get_lexer_by_name("text")

    tokens = list(pygments.lex(code, lexer))

    # Build colored char grid: list of (char, color) per line
    colored_lines: list[list[tuple[str, str]]] = [[]]
    for ttype, value in tokens:
        color = colors.get(_pygments_token_to_role(ttype), colors["default"])
        for ch in value:
            if ch == "\n":
                colored_lines.append([])
            else:
                colored_lines[-1].append((ch, color))

    # Draw line numbers + code
    for i, chars in enumerate(colored_lines):
        y = padding + i * line_height
        x = padding

        if line_numbers:
            ln_str = str(i + 1).rjust(len(str(n_lines)))
            draw.text((x, y), ln_str, font=font_ln, fill=colors["comment"])
            x += ln_width + 8

        for idx, (ch, color) in enumerate(chars):
            draw.text((x + int(idx * char_w), y), ch, font=font, fill=color)

    img.save(output_path, "PNG")
    return output_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _demo_diagram(output: str):
    boxes = [
        {"label": "User / Dominik", "row": 0, "col": 1},
        {"label": "Claude Agent", "row": 1, "col": 1},
        {"label": "Web Search", "row": 2, "col": 0},
        {"label": "Memory", "row": 2, "col": 1},
        {"label": "Code Exec", "row": 2, "col": 2},
        {"label": "Output", "row": 3, "col": 1},
    ]
    arrows = [
        {"from": "User / Dominik", "to": "Claude Agent"},
        {"from": "Claude Agent", "to": "Web Search"},
        {"from": "Claude Agent", "to": "Memory"},
        {"from": "Claude Agent", "to": "Code Exec"},
        {"from": "Web Search", "to": "Output"},
        {"from": "Memory", "to": "Output"},
        {"from": "Code Exec", "to": "Output"},
    ]
    return make_diagram(boxes, arrows, output)


def _demo_code(output: str):
    code = '''import anthropic

client = anthropic.Anthropic()

message = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "Mi az agentic AI?"}
    ]
)
print(message.content[0].text)'''
    return make_code_image(code, "python", output, theme="monokai")


def main():
    parser = argparse.ArgumentParser(description="BigBen visual tools (clean-room)")
    sub = parser.add_subparsers(dest="cmd")

    d = sub.add_parser("diagram", help="Generate a box-and-arrow diagram")
    d.add_argument("--out", required=True)
    d.add_argument("--json", dest="json_data", help='JSON: {"boxes":[...],"arrows":[...]}')
    d.add_argument("--width", type=int, default=1280)
    d.add_argument("--height", type=int, default=720)
    d.add_argument("--demo", action="store_true")

    c = sub.add_parser("code", help="Generate a syntax-highlighted code image")
    c.add_argument("--out", required=True)
    c.add_argument("--lang", default="python")
    c.add_argument("--theme", default="monokai", choices=list(THEMES))
    c.add_argument("--code", help="Code string (else reads stdin)")
    c.add_argument("--width", type=int, default=1280)
    c.add_argument("--font-size", type=int, default=22)
    c.add_argument("--no-line-numbers", action="store_true")
    c.add_argument("--demo", action="store_true")

    args = parser.parse_args()

    if args.cmd == "diagram":
        if args.demo:
            out = _demo_diagram(args.out)
        else:
            data = json.loads(args.json_data)
            out = make_diagram(data["boxes"], data.get("arrows", []), args.out, args.width, args.height)
        print(out)

    elif args.cmd == "code":
        if args.demo:
            out = _demo_code(args.out)
        else:
            code = args.code or sys.stdin.read()
            out = make_code_image(code, args.lang, args.out, args.theme, args.width, args.font_size,
                                  line_numbers=not args.no_line_numbers)
        print(out)

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
