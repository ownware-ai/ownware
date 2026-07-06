---
name: pptx
description: Generate a PowerPoint deck (.pptx) with a consistent slide master, asking-title headlines, finance-grade chart and table layouts, citations on every exhibit, and a sources slide. Use when a parent skill needs to deliver a deck — pitchbook, one-pager, client review, portfolio review, board pack — or when a long-form deliverable should land as slides rather than a memo.
trigger: /pptx
---

# PPTX — Decks an MD will actually use in the room

## Overview

A deck that survives the printer-and-projector test. Every slide has one headline that states the takeaway in a sentence. Every exhibit has a citation. The slide master is consistent across the deck. Charts are editable (native pptx chart objects) where the parent skill calls for it; otherwise rendered as crisp PNGs from matplotlib at print resolution.

You produce this by writing a Python script that uses `python-pptx` (and `matplotlib` for chart images when needed) and running it via `shell_execute`. Do not paste markdown bullets and call them slides — write the script, run it, verify the file opens.

---

## Critical Constraints — read these first, every time

1. **Asking-title headlines, not topic labels.** Title is the takeaway: "AAPL trades 18% below peer-median DCF". Not the topic: "Valuation". The reader scans the deck and the headlines tell the story alone.
2. **One idea per slide.** If the slide needs two takeaways, it needs to be two slides. A deck with 12 over-stuffed slides is harder to follow than 18 clean ones.
3. **Citations on every exhibit.** Footnote at slide bottom in 9pt grey: `Source: Company filings, FactSet (as of <date>); Ownware analysis.` Where multiple sources, separate with semicolons. No exhibit without provenance.
4. **Slide master is the source of truth.** Title size, body size, accent color, footer, page number — all defined once on the master. Individual slides do not override fonts. If a slide-level override is needed, surface it to the user before doing it.
5. **Chart resolution.** Matplotlib charts saved as PNG must use `dpi=300` (print-quality). Width sized so the image fills the content area without scaling artifacts. Native pptx charts must use deck colors via the chart format, not matplotlib defaults.
6. **No Lorem Ipsum, no placeholders.** Every text box on every slide carries real content. If a number isn't available, the slide says "Not yet sourced — flagged for the analyst" with a visible flag, not blank space.
7. **Standard slide types in canonical order.** Title → Executive Summary (the asks / key numbers / recommendation) → Section dividers → Content slides → Football Field (when valuation work) → Sources → Disclaimer. The parent skill specifies which subset.
8. **Footer + page number on every body slide.** Project codename on left, page X of N on right. Title slide and dividers are exempt.
9. **Aspect ratio 16:9 by default.** `prs.slide_width = Inches(13.333); prs.slide_height = Inches(7.5)`. Override only if the parent skill specifies (some clients still want 4:3).
10. **Verify before claiming done.** Open the saved file with `Presentation(...)` again; assert slide count matches plan, every slide has a title, master is the one we set, no slide has placeholder text.

---

## Workflow

### Step 1 — Confirm the parent's slide plan

The parent skill (`/one-pager`, `/client-review`, `/pitchbook`, etc.) specifies:

- Output path + file name (e.g. `<Project>_OnePager_<YYYYMMDD>.pptx`).
- Slide count and per-slide content brief.
- Whether charts are native pptx or rendered PNGs.
- Brand template file (.pptx with masters) if the firm has one.
- Footer text (project codename / disclaimer).

If anything is missing, **stop and ask** — do not invent.

### Step 2 — Verify the Python toolchain

```bash
python3 -c "import pptx, matplotlib; print(pptx.__version__, matplotlib.__version__)"
```

If `ModuleNotFoundError`, surface the same install message as `/xlsx`:

> "This skill needs Python 3.10+ with `python-pptx` and `matplotlib`. Run `python3 -m pip install --user python-pptx matplotlib` once, then retry."

### Step 3 — Write the build script

If the firm has a brand template, start from it:

```python
from pptx import Presentation
prs = Presentation('/path/to/firm_template.pptx')
```

Otherwise build a clean default master with deck colors set explicitly. Standard skeleton:

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

# Color palette — parent skill may override
NAVY = RGBColor(0x0A, 0x2A, 0x4A)
ACCENT = RGBColor(0xD4, 0xA0, 0x17)
TEXT = RGBColor(0x22, 0x22, 0x22)
MUTED = RGBColor(0x88, 0x88, 0x88)

# helpers
def add_title(slide, text):
    title_box = slide.shapes.add_textbox(Inches(0.5), Inches(0.3), Inches(12.3), Inches(0.7))
    tf = title_box.text_frame
    tf.text = text
    p = tf.paragraphs[0]
    p.font.size = Pt(24)
    p.font.bold = True
    p.font.color.rgb = NAVY

def add_footer(slide, page_num, total_pages, project='PROJECT_NAME'):
    foot = slide.shapes.add_textbox(Inches(0.5), Inches(7.0), Inches(12.3), Inches(0.3))
    tf = foot.text_frame
    p = tf.paragraphs[0]
    p.text = project
    p.font.size = Pt(9)
    p.font.color.rgb = MUTED
    pg = slide.shapes.add_textbox(Inches(12.3), Inches(7.0), Inches(0.7), Inches(0.3))
    pg_p = pg.text_frame.paragraphs[0]
    pg_p.text = f'{page_num} / {total_pages}'
    pg_p.alignment = PP_ALIGN.RIGHT
    pg_p.font.size = Pt(9)
    pg_p.font.color.rgb = MUTED

def add_source(slide, text):
    src = slide.shapes.add_textbox(Inches(0.5), Inches(6.7), Inches(12.3), Inches(0.3))
    p = src.text_frame.paragraphs[0]
    p.text = f'Source: {text}'
    p.font.size = Pt(9)
    p.font.color.rgb = MUTED
    p.font.italic = True

# ... add slides per the parent's plan ...

prs.save('/path/from/parent/<Project>_<Type>_<YYYYMMDD>.pptx')
```

### Step 4 — Charts

For native (editable) charts, use `slide.shapes.add_chart` with `XL_CHART_TYPE`. For matplotlib renders:

```python
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(8, 4.5), dpi=300)
ax.bar(comp_names, ev_ebitda, color='#0A2A4A')
ax.set_ylabel('EV / EBITDA (x)', fontsize=10)
ax.set_title('')  # title comes from slide headline, not chart
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
fig.tight_layout()
fig.savefig('/tmp/comps_chart.png', dpi=300, bbox_inches='tight')
plt.close(fig)
slide.shapes.add_picture('/tmp/comps_chart.png', Inches(0.5), Inches(1.2), width=Inches(12.3))
```

Note: chart titles live on the slide (the asking-title), not inside the chart. Less visual noise.

### Step 5 — Run + verify

After saving, open the file again and assert:

```python
from pptx import Presentation
prs = Presentation('<path>')
assert len(prs.slides) == EXPECTED_COUNT
for i, slide in enumerate(prs.slides, 1):
    titles = [s for s in slide.shapes if s.has_text_frame and s.text_frame.text.strip()]
    assert titles, f'slide {i} has no text'
print('OK')
```

### Step 6 — Surface the path

Return path + summary + any flagged caveats to the parent skill.

---

<correct_patterns>

### Asking-title vs topic label

```python
# WRONG (topic label)
add_title(slide, 'Valuation')

# RIGHT (asking-title — the takeaway in one sentence)
add_title(slide, 'AAPL trades at $208 implied vs $185 spot — 12% upside, 5×5 sensitivity below')
```

The reader can flip to any slide and the headline alone tells them what they're looking at.

### Footer with page number on every body slide

```python
total = len([s for s in slide_plan if s['kind'] not in ('title', 'divider')])
page_num = 0
for spec in slide_plan:
    layout = prs.slide_layouts[6]  # blank
    slide = prs.slides.add_slide(layout)
    add_title(slide, spec['headline'])
    if spec['kind'] not in ('title', 'divider'):
        page_num += 1
        add_footer(slide, page_num, total, project=PROJECT)
    if spec.get('source'):
        add_source(slide, spec['source'])
```

Title slide + section dividers are exempt; everything else has the footer.

### Source line on every exhibit slide

```python
add_source(slide, 'Company 10-K FY2024, FactSet consensus (2026-05-07); Ownware analysis')
```

Multiple sources, semicolon-separated. Italic, 9pt, muted color. Reader knows where the numbers came from without breaking the slide flow.

### Matplotlib at print resolution, deck colors

```python
fig, ax = plt.subplots(figsize=(8, 4.5), dpi=300)
ax.bar(comp_names, ev_ebitda, color='#0A2A4A')        # deck navy, not matplotlib default blue
ax.set_axisbelow(True)
ax.grid(True, axis='y', linestyle=':', linewidth=0.5, color='#CCCCCC')
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
ax.tick_params(labelsize=9)
fig.tight_layout()
fig.savefig('/tmp/c.png', dpi=300, bbox_inches='tight')
```

300dpi means it survives projection AND print. Deck color (`#0A2A4A`) on bars matches the slide master; matplotlib's default blue clashes.

### Football-field bar layout

```python
methods = ['52-week range', 'Trading comps EV/EBITDA', 'Trading comps P/E', 'DCF (5Y)', 'Precedent transactions']
lows = [165, 178, 172, 188, 195]
highs = [205, 220, 218, 230, 245]
spot = 185

fig, ax = plt.subplots(figsize=(10, 5), dpi=300)
y = list(range(len(methods)))
ax.barh(y, [h - l for h, l in zip(highs, lows)], left=lows, color='#0A2A4A', alpha=0.7)
ax.axvline(spot, color='#D4A017', linewidth=2, linestyle='--', label=f'Current: ${spot}')
ax.set_yticks(y)
ax.set_yticklabels(methods, fontsize=10)
ax.set_xlabel('Implied price ($)', fontsize=10)
ax.legend(loc='lower right', frameon=False, fontsize=9)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
fig.tight_layout()
fig.savefig('/tmp/ff.png', dpi=300, bbox_inches='tight')
```

Methods on Y, range on X, spot price as a vertical line. The standard football field.

</correct_patterns>

<common_mistakes>

### WRONG: topic-label titles

```python
add_title(slide, 'Industry Overview')
```

The reader has to read the body to learn what's being said. Asking-title gives them the answer up front.

### WRONG: matplotlib defaults

```python
ax.bar(names, values)   # default blue, default fonts, low DPI
fig.savefig('chart.png')   # default 100 dpi
```

Looks like a draft from a stats class. Sets DPI 300, deck color, 10pt readable axis labels.

### WRONG: charts with embedded titles

```python
ax.set_title('AAPL trades 18% below peer median')
add_title(slide, 'Comps')
```

Title duplicated, visual noise. Title on the slide; chart shows the data.

### WRONG: source line missing

```python
slide_with_chart_but_no_source = ...
```

A reader cannot defend a number without a source. A footer source line is non-negotiable on exhibit slides.

### WRONG: 4:3 aspect ratio by default

```python
prs = Presentation()  # default is 4:3
```

Modern projectors and laptops are 16:9; 4:3 leaves black bars. Set `slide_width / slide_height` to 13.333 / 7.5 unless the parent says otherwise.

### TOP 5 ERRORS

1. Topic labels instead of asking-title headlines (reader has to work to extract the takeaway)
2. Missing source line on exhibit slides (numbers floating without provenance)
3. Matplotlib defaults — wrong color, wrong DPI, axis-clutter (looks unfinished)
4. Chart title inside the chart instead of as the slide headline (duplicate, noisy)
5. Default 4:3 aspect ratio (looks dated on every modern screen)

</common_mistakes>

---

## Quality Rubric

Every deck must maximise for:

1. **Asking-title headlines** — every body slide leads with its takeaway.
2. **Master discipline** — fonts, colors, sizes consistent across all slides.
3. **Citation density** — every exhibit slide has a source line.
4. **Chart quality** — print-resolution PNGs (300 dpi) or native pptx charts using deck colors.
5. **Pace** — one idea per slide; if it needs two, it's two slides.
6. **Footer + page numbers** — every body slide; title and dividers exempt.
7. **Real content** — no Lorem Ipsum, no placeholders; flag missing data visibly.

---

## Final Output Checklist

Before delivering, every item must be true:

- [ ] File saved at the parent-specified path with the parent-specified name.
- [ ] Aspect ratio 16:9 (or parent-specified override).
- [ ] Every body slide has an asking-title headline.
- [ ] Every body slide has a footer with project name and page number.
- [ ] Every exhibit slide has a source line.
- [ ] Charts saved at 300 dpi (matplotlib) or use deck colors (native pptx).
- [ ] Slide master is consistent — no per-slide font / color overrides without surfaced reason.
- [ ] No Lorem Ipsum or placeholder strings remain.
- [ ] Verification script ran without assertion errors.
- [ ] Path returned to parent skill with summary + any flagged caveats.
