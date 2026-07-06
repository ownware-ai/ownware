---
name: pptx-export
description: Write a python-pptx script the user runs to produce a stakeholder-ready `.pptx` deck that mirrors the HTML deck the `/deck` skill already built. Use when the brief calls for "send me the PowerPoint", "I need to share this with finance / legal / a non-technical exec", or any "open in PowerPoint / Keynote" request. Skip when the user is fine with the HTML artifact (it's more flexible) or when the deck has interactive / scroll-driven elements PowerPoint can't represent.
trigger: /pptx-export
---

# PPTX Export — python-pptx scripts written to disk

## Overview

This skill writes a python-pptx script. Ownware does not generate Office files in-product — the agent produces `./scripts/build-deck.py`; the user runs `pip install python-pptx && python scripts/build-deck.py`. Output lands as `./out/<name>.pptx`. When in-product .pptx export ships, this skill stays the same.

A PowerPoint export earns its place when the deck's audience lives in PowerPoint or Keynote — investors, finance committees, legal review, non-technical execs. For technical demos, marketing handouts, or anything the audience will read in a browser, the HTML deck the `/deck` skill builds is better. This skill is the bridge for the moments when the HTML isn't enough.

The content slides in the `.pptx` MUST mirror the HTML deck — same slide order, same titles, same beat. The PowerPoint is a *re-targeting*, not a re-design. If the HTML deck doesn't exist yet, build it first with `/deck`, then run this skill.

---

## Critical Constraints — read these first, every time

1. **The agent writes; the user runs.** Never invoke `shell_execute` to run Python. The user installs `python-pptx` and runs the script. Ownware doesn't ship Office bindings.
2. **Pin python-pptx.** `pip install python-pptx==0.6.23` in the user-facing run instruction. A newer python-pptx may rename a layout enum and break the script silently.
3. **One script per deck.** `./scripts/build-deck.py` is the canonical filename. Output goes to `./out/<deck-slug>.pptx`.
4. **Mirror the HTML deck's slide order and titles.** If the HTML deck is `cover → problem → solution → metrics → CTA`, the PPTX is the same five slides in the same order. Don't reorder; don't drop; don't add.
5. **16:9 widescreen.** `prs.slide_width = Inches(13.333)`, `prs.slide_height = Inches(7.5)`. Never 4:3 — looks dated even when the deck is for legacy audiences.
6. **Brand colors at the top of the file.** All `RGBColor` values defined once as constants. When the user changes the accent, one edit propagates.
7. **Use `Inches` / `Pt` from `pptx.util`.** Never raw `914400` EMU integers. `Inches(0.5)` reads. `914400` is unmaintainable.
8. **Helper functions, not 5 copy-pasted slide blocks.** Write `add_title_slide(prs, title, subtitle)` and `add_content_slide(prs, title, body_lines)` once; call them five times. The script stays under 150 lines.

---

## The canonical script — produce this shape, every time

```python
# scripts/build-deck.py
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dgm.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pathlib import Path

# ---- BRAND TOKENS (mirror :root from the HTML deck) ------------------
BG          = RGBColor(0x0D, 0x11, 0x17)   # near-black
SURFACE     = RGBColor(0x16, 0x1B, 0x22)
FG          = RGBColor(0xE6, 0xED, 0xF3)
MUTED       = RGBColor(0x8B, 0x94, 0x9E)
ACCENT      = RGBColor(0x58, 0xA6, 0xFF)   # GitHub-ish blue, matches deck
ACCENT_FG   = RGBColor(0x0D, 0x11, 0x17)

# ---- BUILD ----------------------------------------------------------
OUT_DIR = Path('./out')
OUT_DIR.mkdir(parents=True, exist_ok=True)

prs = Presentation()
prs.slide_width  = Inches(13.333)
prs.slide_height = Inches(7.5)

# Layout indexes in the default master:
#   0 = TITLE          (centered title + subtitle)
#   1 = TITLE_AND_CONTENT
#   3 = TWO_CONTENT
#   5 = TITLE_ONLY
#   6 = BLANK
BLANK = prs.slide_layouts[6]

def paint_background(slide, color):
    bg = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height,
    )
    bg.fill.solid()
    bg.fill.fore_color.rgb = color
    bg.line.fill.background()
    # send to back
    sp = bg._element
    sp.getparent().remove(sp)
    slide.shapes._spTree.insert(2, sp)

def add_title_slide(prs, title, subtitle):
    slide = prs.slides.add_slide(BLANK)
    paint_background(slide, BG)

    title_box = slide.shapes.add_textbox(
        Inches(0.8), Inches(2.6), Inches(11.7), Inches(2.0),
    )
    tf = title_box.text_frame
    tf.text = title
    p = tf.paragraphs[0]
    p.font.name = 'Inter'
    p.font.size = Pt(64)
    p.font.bold = True
    p.font.color.rgb = FG
    p.alignment = PP_ALIGN.LEFT

    sub_box = slide.shapes.add_textbox(
        Inches(0.8), Inches(4.7), Inches(11.7), Inches(0.9),
    )
    tf = sub_box.text_frame
    tf.text = subtitle
    p = tf.paragraphs[0]
    p.font.name = 'Inter'
    p.font.size = Pt(20)
    p.font.color.rgb = MUTED
    return slide

def add_content_slide(prs, title, bullets):
    slide = prs.slides.add_slide(BLANK)
    paint_background(slide, BG)

    title_box = slide.shapes.add_textbox(
        Inches(0.8), Inches(0.6), Inches(11.7), Inches(0.9),
    )
    tf = title_box.text_frame
    tf.text = title
    p = tf.paragraphs[0]
    p.font.name = 'Inter'; p.font.size = Pt(32); p.font.bold = True; p.font.color.rgb = FG

    body_box = slide.shapes.add_textbox(
        Inches(0.8), Inches(1.8), Inches(11.7), Inches(5.0),
    )
    tf = body_box.text_frame
    tf.word_wrap = True
    for i, line in enumerate(bullets):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = line
        p.font.name = 'Inter'
        p.font.size = Pt(22)
        p.font.color.rgb = FG
        p.space_after = Pt(12)
    return slide

# ---- THE FIVE SLIDES (mirror /deck output) --------------------------
add_title_slide(
    prs,
    'Acme — Q3 board review',
    'September 2026 · Confidential',
)
add_content_slide(prs, 'The problem', [
    'Deployments take 47 minutes on average — engineers ship 1.4× per week.',
    'Rollback is manual and takes another 22 minutes when it goes wrong.',
    'Six on-call incidents in Q2 traced to deploy-window mistakes.',
])
add_content_slide(prs, 'Our solution', [
    'One-command deploy, atomic by default, with automatic preview environments.',
    'Rollback is a single button — average recovery 38 seconds.',
    'Zero config: works the day the team installs.',
])
add_content_slide(prs, 'Metrics that moved', [
    'Ship velocity: 1.4 → 6.2 deploys per engineer per week.',
    'MTTR: 22 min → 38 sec.',
    'Incident count: 6 → 1 in Q3 to date.',
])
add_content_slide(prs, 'What we are asking for', [
    'Approval to extend the rollout from 3 teams to all of engineering.',
    'Budget for two SRE hires to own the platform.',
    'Decision by October 15.',
])

out = OUT_DIR / 'acme-q3-board.pptx'
prs.save(out)
print(f'wrote {out}')
```

That's the whole script — under 130 lines, two helper functions, five call sites. Add a sixth slide by adding a sixth call.

Note on the `pptx.dgm.color` import: `from pptx.dgm.color import RGBColor` is the correct path for python-pptx 0.6.23. If the user is on an older release, swap to `from pptx.util import RGBColor` (some older versions exposed it there). Pinning the version sidesteps this.

---

## Concrete examples — two end-to-end scripts

### Example 1 — 5-slide investor update mirroring the HTML deck

User already has an HTML deck from `/deck` at `./index.html` with five slides: cover, problem, solution, metrics, CTA.

Agent writes `./scripts/build-deck.py` as shown above — same five slides, same titles, same bullet beats. The HTML deck's `:root` token block is the source for the `BG / SURFACE / FG / MUTED / ACCENT` values at the top of the Python file.

Reply: "Wrote `./scripts/build-deck.py`. Run `pip install python-pptx==0.6.23 && python scripts/build-deck.py`. Output lands at `./out/acme-q3-board.pptx`. The five slides mirror your HTML deck one-to-one — same order, same titles, same key messages, just re-targeted for PowerPoint."

### Example 2 — 10-slide pitch deck with a quote slide and two-content layout

User: "Same deal but it's a seed pitch. Cover, problem, solution, market, traction, GTM, team, ask, quote from a design partner, end-card."

Agent writes the script with a third helper — `add_quote_slide(prs, quote, attribution)` — that draws a large `Pt(40)` italicized quote centered, with the attribution `Pt(16)` muted below. The traction slide uses `add_two_column_slide(prs, title, left_lines, right_lines)`: title at top, two text boxes at `Inches(0.8), Inches(1.8), Inches(5.7), Inches(5)` and `Inches(6.8), Inches(1.8), Inches(5.7), Inches(5)`. Ten call sites, ~180 lines total.

Output: `./out/acme-seed-pitch.pptx`. Same install/run line as Example 1.

---

## Anti-patterns

- **Calling `shell_execute` to run Python.** Stop. The user installs `python-pptx` and runs it. Ownware doesn't ship Python bindings.
- **Raw EMU integers like `914400`.** Stop. Use `Inches(1)`, `Pt(24)`. EMU math is unreadable.
- **One 800-line script with 10 copy-pasted slide blocks.** Stop. Two helper functions (title slide + content slide), one call per slide. Add a third helper only when a slide truly differs (quote slide, two-column slide).
- **Reordering slides relative to the HTML deck.** Stop. The PPTX mirrors the HTML one-to-one. The user's mental model is the HTML; the PPTX is the same thing in a different file format.
- **4:3 aspect ratio.** Stop. `13.333 × 7.5 inches` (16:9) is the only modern shape. Even legacy audiences see 16:9 now.
- **Embedding the HTML deck's chart as an inline SVG.** Stop. python-pptx supports SVG poorly across versions and PowerPoint's renderer mangles complex paths. If the slide has a chart, either re-create it with python-pptx native shapes / `add_chart()`, or export the chart as a PNG via the screenshot script and `add_picture()`.
- **Using `pptx.enum.text.MSO_AUTO_SHAPE_TYPE`** for everything. Stop. Plain text boxes with a colored rectangle behind are simpler, more reliable, and easier to edit.
- **Skipping the brand-color block.** Stop. Define `BG / FG / MUTED / ACCENT` as `RGBColor` constants at the top. When the user wants the deck in their second brand palette, one edit per file.
- **Hardcoding `prs = Presentation('template.pptx')` against a template the user doesn't have.** Stop. Start from `Presentation()` (default master) and paint the slide background ourselves with a rectangle. Portable across machines.
