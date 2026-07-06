---
name: docx
description: Generate a long-form Word document (.docx) with consistent heading styles, headers and footers, page numbers, table-of-contents field, structured tables, footnoted citations, and a cover page. Use when a parent skill needs a document deliverable — CIM, IC memo, process letter, KYC report, portfolio commentary, financial-plan narrative, or any case where the output is read top-to-bottom rather than skimmed as slides.
trigger: /docx
---

# DOCX — Documents that read like the firm wrote them

## Overview

A long-form document the analyst can hand to a client, a credit committee, or counsel without a stylist passing over it. Heading styles are consistent. Page numbers and headers are set. Tables hold structured data, not pasted text. Citations live in footnotes (or in a Sources section if the firm convention requires it). The cover page has the codename, the date, the version, and the confidentiality stamp the parent skill specifies.

You produce this by writing a Python script that uses `python-docx` and running it via `shell_execute`. Do not hand back a markdown blob — write the script, save the file, verify it opens and the styles are right.

---

## Critical Constraints — read these first, every time

1. **Use built-in heading styles.** `doc.add_heading(text, level=1)` for H1, level 2 for H2, level 3 for H3. Never bold a paragraph and call it a heading. Word's TOC field, navigation pane, and accessibility tree all key off the heading style.
2. **Cover page is its own page.** Title, codename, date, version (`v1.0` / `Draft`), confidentiality stamp (`STRICTLY CONFIDENTIAL` for CIM-class). Then `add_page_break()`. The body starts on page 2.
3. **Table of contents field.** Insert a TOC field after the cover. Word will populate it on first open (`Right-click → Update Field`). Do not try to render the TOC as static text — it goes stale immediately.
4. **Headers + footers + page numbers.** Section header carries the codename or doc title. Footer carries page number (`Page X of Y` or just `X`). Cover page is exempt — different first-page header/footer.
5. **Tables for tabular data.** Use `doc.add_table(rows, cols)` with a real style (`Light Grid Accent 1` is a sensible default; firms often override). Do not paste markdown pipe-tables and call it done.
6. **Citations as footnotes (or Sources section per firm convention).** `python-docx` does not natively support footnotes in older versions — check; if not supported, use parenthetical citations inline (`(Apple 10-K FY2024, p. 32)`) and a Sources section at the end. Do not invent citation numbers.
7. **Anonymization discipline for CIM-class docs.** If the parent skill is `/cim` or `/teaser`, replace the target's name everywhere with the codename (e.g. "Project Atlas / the Company"). Search-and-replace at the end as a verify step. Leak of the real name is a process-letter-level mistake.
8. **Tracked changes off, comments off in the saved file.** Final deliverable is clean. If the parent wants a redline draft, that's a separate slice.
9. **Page size A4 vs Letter per firm convention.** Default Letter (US) unless parent specifies. Margins: 1 inch top/bottom, 1 inch left/right (standard).
10. **Verify before claiming done.** Open the saved file with `Document(...)`; assert heading styles applied, page count >= expected, codename appears, real name does not appear (for CIM-class), page-number field present.

---

## Workflow

### Step 1 — Confirm the parent's structure

The parent skill (`/cim`, `/ic-memo`, `/process-letter`, `/kyc`, etc.) hands you:

- File path + name (`<Codename>_CIM_v1.0_<YYYYMMDD>.docx`).
- Section outline (H1 / H2 list).
- Per-section content briefs.
- Tables (each: caption, columns, rows).
- Citation style (footnotes vs Sources section).
- Codename, real-name (only used if the doc is internal), confidentiality stamp.
- Page size (US Letter / A4).

If anything missing, **stop and ask** — do not invent.

### Step 2 — Verify the Python toolchain

```bash
python3 -c "import docx; print(docx.__version__)"
```

If `ModuleNotFoundError`:

> "This skill needs Python 3.10+ with `python-docx`. Run `python3 -m pip install --user python-docx` once, then retry."

### Step 3 — Write the build script

```python
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

doc = Document()

# Page geometry — default Letter
section = doc.sections[0]
section.top_margin = Inches(1)
section.bottom_margin = Inches(1)
section.left_margin = Inches(1)
section.right_margin = Inches(1)
# Different first-page header/footer (cover page is exempt)
section.different_first_page_header_footer = True

# Cover page
title = doc.add_paragraph()
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = title.add_run('PROJECT ATLAS')
run.font.size = Pt(28)
run.bold = True

sub = doc.add_paragraph()
sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
sub.add_run('Confidential Information Memorandum').font.size = Pt(16)

date_p = doc.add_paragraph()
date_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
date_p.add_run('May 2026 — v1.0').font.size = Pt(12)

stamp = doc.add_paragraph()
stamp.alignment = WD_ALIGN_PARAGRAPH.CENTER
sr = stamp.add_run('STRICTLY CONFIDENTIAL')
sr.bold = True
sr.font.color.rgb = RGBColor(0xC0, 0x10, 0x10)

doc.add_page_break()

# TOC field — Word populates on open
para = doc.add_paragraph()
fld_begin = OxmlElement('w:fldChar'); fld_begin.set(qn('w:fldCharType'), 'begin')
instr = OxmlElement('w:instrText'); instr.text = 'TOC \\o "1-3" \\h \\z \\u'
fld_sep = OxmlElement('w:fldChar'); fld_sep.set(qn('w:fldCharType'), 'separate')
placeholder = OxmlElement('w:t'); placeholder.text = 'Right-click → Update Field to populate.'
fld_end = OxmlElement('w:fldChar'); fld_end.set(qn('w:fldCharType'), 'end')
r = para.add_run()
r._r.append(fld_begin); r._r.append(instr); r._r.append(fld_sep); r._r.append(placeholder); r._r.append(fld_end)

doc.add_page_break()

# Body — built from the parent's outline
doc.add_heading('Executive Summary', level=1)
doc.add_paragraph("Project Atlas is …")

doc.add_heading('The Company', level=1)
doc.add_heading('Business Description', level=2)
doc.add_paragraph("…")

# Tables
doc.add_heading('Historical Financials', level=2)
table = doc.add_table(rows=4, cols=4)
table.style = 'Light Grid Accent 1'
hdr = table.rows[0].cells
hdr[0].text = ''
hdr[1].text = 'FY2022'
hdr[2].text = 'FY2023'
hdr[3].text = 'FY2024'
for col_idx, label in enumerate(['Revenue ($M)', 'EBITDA ($M)', 'Margin %'], start=1):
    table.rows[col_idx].cells[0].text = label

# (fill numeric cells per parent's data...)

# Header (project name) + footer (page number) — applies to body, not cover
header = section.header
hp = header.paragraphs[0]
hp.text = 'Project Atlas — Confidential'
hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT

footer = section.footer
fp = footer.paragraphs[0]
fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
# Insert PAGE field
fld = OxmlElement('w:fldSimple')
fld.set(qn('w:instr'), 'PAGE')
t = OxmlElement('w:t'); t.text = '1'
fld.append(t)
fp._p.append(fld)

doc.save('/path/from/parent/<Codename>_<Type>_v1.0_<YYYYMMDD>.docx')
```

### Step 4 — Anonymisation pass (for /cim, /teaser, any CIM-class)

After the body is built and before saving, walk the document and assert the real name does not appear:

```python
real = 'Acme Corporation'
codename = 'Project Atlas'
for para in doc.paragraphs:
    if real.lower() in para.text.lower():
        raise SystemExit(f'leak: real name in paragraph: {para.text[:80]}')
for tbl in doc.tables:
    for row in tbl.rows:
        for cell in row.cells:
            if real.lower() in cell.text.lower():
                raise SystemExit(f'leak: real name in table cell: {cell.text[:80]}')
```

A real-name leak in a CIM is a process-letter-level mistake. The check is non-negotiable for CIM-class docs.

### Step 5 — Run + verify

```python
from docx import Document
d = Document('<path>')
heading_levels = []
for p in d.paragraphs:
    if p.style.name.startswith('Heading'):
        heading_levels.append(int(p.style.name.split()[1]))
assert 1 in heading_levels, 'no H1 found'
# (parent specifies expected H1 set; assert presence)
```

### Step 6 — Surface the path

Return path + section count + word count + any flagged caveats (missing data, citation gaps).

---

<correct_patterns>

### Heading styles, not bold paragraphs

```python
# RIGHT
doc.add_heading('Investment Thesis', level=1)
doc.add_heading('Market Position', level=2)

# WRONG
para = doc.add_paragraph()
run = para.add_run('Investment Thesis')
run.bold = True
run.font.size = Pt(18)
```

The right form populates the TOC and the navigation pane. The wrong form is invisible to both.

### Tables with a real style

```python
table = doc.add_table(rows=5, cols=4)
table.style = 'Light Grid Accent 1'
table.rows[0].cells[0].text = 'Metric'
table.rows[0].cells[1].text = 'FY2022'
table.rows[0].cells[2].text = 'FY2023'
table.rows[0].cells[3].text = 'FY2024'
# ... fill body cells
```

A styled table renders with consistent borders and shading. Without `table.style`, you get an unfilled grid that prints unevenly.

### Inline citation when footnotes unavailable

```python
p = doc.add_paragraph(
    "Revenue grew 12.7% in FY2024, driven by services attach (Apple 10-K FY2024, p. 32)."
)
```

Parenthetical citations carry the source inline. A Sources section at the end can collect the full bibliography.

### Confidentiality stamp on cover

```python
stamp = doc.add_paragraph()
stamp.alignment = WD_ALIGN_PARAGRAPH.CENTER
sr = stamp.add_run('STRICTLY CONFIDENTIAL')
sr.bold = True
sr.font.color.rgb = RGBColor(0xC0, 0x10, 0x10)
sr.font.size = Pt(14)
```

Red, bold, centered. Repeated in the section header on every body page (`Project Atlas — Confidential`).

### Different first-page header/footer

```python
section = doc.sections[0]
section.different_first_page_header_footer = True
# the cover then has its own (empty) header/footer; body inherits the section's
```

Cover has no page number, no running header. Body does. This is what makes the doc look like a real deliverable instead of a rendered template.

</correct_patterns>

<common_mistakes>

### WRONG: bold paragraphs masquerading as headings

```python
p = doc.add_paragraph('Section 1')
p.runs[0].bold = True
p.runs[0].font.size = Pt(16)
```

TOC won't pick it up. Navigation pane won't show it. Use `add_heading(text, level=N)`.

### WRONG: tables without style

```python
t = doc.add_table(rows=3, cols=3)
# no t.style assigned
```

Renders without borders or with default ones; looks unfinished.

### WRONG: pasting markdown tables as paragraphs

```python
doc.add_paragraph('| Metric | FY24 |\n|---|---|\n| Revenue | 383 |')
```

That's not a table — it's a paragraph that happens to contain pipe characters. Use `doc.add_table`.

### WRONG: real name leaking into a CIM

```python
doc.add_paragraph('Acme Corp posted record FY2024 revenue.')   # for a /cim
```

The whole point of a CIM is that the buyer-list version of the doc cannot identify the seller until NDA is countersigned. Replace `Acme Corp` with `the Company` or `Project Atlas` everywhere.

### WRONG: rendering the TOC as static text

```python
doc.add_paragraph('1. Executive Summary ............ 3')
doc.add_paragraph('2. The Company ................. 5')
```

Drifts the moment a section moves. Use the TOC field; Word repopulates it on open.

### TOP 5 ERRORS

1. Bold paragraphs instead of `add_heading` (TOC + navigation broken)
2. Tables without `.style` (renders without borders / looks unfinished)
3. Static TOC text instead of a TOC field (goes stale immediately)
4. Real name leaking in CIM-class docs (anonymisation pass missing)
5. No different-first-page header/footer (page number on cover, looks amateur)

</common_mistakes>

---

## Quality Rubric

Every document must maximise for:

1. **Heading discipline** — `add_heading(text, level=N)` for every section header; no bold-paragraph fakes.
2. **TOC field present** — populates on Word open; never static text.
3. **Cover page distinct** — different first-page header/footer; no page number on cover.
4. **Tables styled** — every `add_table` has a `.style`; numeric columns right-aligned.
5. **Citations consistent** — footnotes or parenthetical inline + Sources section, never mixed.
6. **Anonymisation enforced** — for CIM-class docs, real name fails the verify pass.
7. **Confidentiality stamp** — on cover and header for sensitive deliverables.

---

## Final Output Checklist

Before delivering, every item must be true:

- [ ] File saved at the parent-specified path with the parent-specified name.
- [ ] Cover page present, with title / codename / date / version / confidentiality stamp where required.
- [ ] TOC field inserted (placeholder text reads "Right-click → Update Field").
- [ ] Every section header uses a built-in `Heading 1` / `Heading 2` / `Heading 3` style.
- [ ] All data tables use a `.style`; numeric columns right-aligned where appropriate.
- [ ] Citations consistent across the doc (footnote OR parenthetical-plus-Sources, not mixed).
- [ ] For CIM-class docs: anonymisation verify passes — real name does not appear anywhere.
- [ ] Different first-page header/footer set; cover has no page number.
- [ ] Header carries codename / doc title; footer carries page number.
- [ ] Verification script ran without assertion errors.
- [ ] Path returned to parent with section count, word count, any flagged caveats.
