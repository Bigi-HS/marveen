---
name: NoA
colors:
  bg-deep: "#152528"
  bg-surface: "#1e3236"
  bg-elevated: "#2a3f44"
  border: "#37535a"
  primary: "#de6f23"
  primary-hover: "#e8823a"
  primary-press: "#c75c18"
  accent: "#2fc4ed"
  accent-glow: "#53e9ff"
  neutral: "#8a929b"
  text: "#e6eef0"
  text-muted: "#9fb0b3"
  status-done: "#4fb477"
components:
  body-text:
    backgroundColor: "{colors.bg-deep}"
    textColor: "{colors.text}"
  text-on-surface:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text}"
  text-on-elevated:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.text}"
  muted-caption:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-muted}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.bg-deep}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.bg-deep}"
  link-accent:
    backgroundColor: "{colors.bg-deep}"
    textColor: "{colors.accent}"
  status-done-pill:
    backgroundColor: "{colors.status-done}"
    textColor: "{colors.bg-deep}"
---

## Overview

NoA is the control-plane visual identity: calm, dark slate surfaces under a single
dominant brand orange for calls-to-action and active state, with electric cyan
reserved for data, live motion, and focus. This DESIGN.md is the machine-readable
layer beside the prose design system (`store/dashboard-design-system.md`). It is NOT
the source of truth for the hex values -- `dashboard-new/styles/tokens.css` is; this
file mirrors those tokens so a coding agent has a structured, contrast-checked view,
and a parity test keeps the two in lockstep.

## Colors

- **bg-deep (#152528):** Deepest surface and page background.
- **bg-surface (#1e3236):** Card and panel surface, one step above the page.
- **bg-elevated (#2a3f44):** Raised surface (menus, hovered rows).
- **border (#37535a):** Hairline separators and outlines.
- **primary (#de6f23):** Brand orange. The dominant accent, max 1-2 focal uses per
  view: CTA, active tab, focal accent. `primary-hover` / `primary-press` are its
  interaction states.
- **accent (#2fc4ed):** Electric cyan for data, live motion, focus rings, graph glow
  (`accent-glow`).
- **neutral (#8a929b):** Muted UI chrome (inactive, planned state).
- **text (#e6eef0) / text-muted (#9fb0b3):** Primary and secondary text on dark
  surfaces.
- **status-done (#4fb477):** Success / done state.

## Components

Each component pins a real foreground/background pair used in the UI so the WCAG
contrast lint can verify legibility. Dark text is placed on the bright brand orange
and success green (they are too light for white text); light `text` sits on the dark
surfaces; cyan is used as a foreground accent on the deep background.
