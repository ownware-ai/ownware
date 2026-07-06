---
name: pdf
description: Read PDFs (filings, investor decks, term sheets) to extract text and tabular data, and build short layout-precise PDFs directly (teasers, one-pagers, single-page summaries) using reportlab. Use when a parent skill needs to ingest a PDF source the user provided, or when the deliverable is a 1-2 page document where pixel-precise layout matters more than long-form narrative structure (in which case use docx instead).
trigger: /pdf
---

# PDF — Read what's given, write what's tight

## Overview

Two jobs. **Read:** extract text, headings, and tables from a PDF the user dropped in (a 10-K, a competitor deck, a term sheet) so the agent can cite from it. **Write:** produce a short, layout-precise PDF directly with `reportlab` for deliverables where docx layout would be too loose (teasers, one-page summaries, fact sheets).

You produce these by writing a Python script using `pypdf` (read) and/or `reportlab` (write) and running it via `shell_execute`. Long-form deliverables (CIMs, IC memos) belong in `/docx`; this skill is for short, exact-layout PDFs and for ingestion of user-provided PDFs.

---

## Critical Constraints — read these first, every time

1. **Choose read or write deliberately.** If the user handed you a PDF to summarise → `pypdf` extract. If the parent skill needs a 1-2 page deliverable → `reportlab` write. Never use this skill to produce a 50-page IC memo — that's `/docx`.
2. **Read mode: do not paraphrase as if extracted.** When extracting, quote the source verbatim with page numbers; do not summarise the source and present it as quoted text. The user must be able to verify against the original.
3. **Read mode: page numbers are 1-indexed in the citation, even if pypdf is 0-indexed internally.** A reader looking at the PDF expects "page 4," not "page 3 (zero-indexed)." Convert at the boundary.
4. **Write mode: layout is precise.** Margins set explicitly (`leftMargin=0.75*inch` etc.). Fonts loaded explicitly (Helvetica is the default; firms often want a brand serif — load the .ttf and register). Every text box positioned with absolute coordinates or via a `Frame` with known geometry.
5. **Write mode: every page has the same header/footer.** Page number, codename, date. Wired through a `PageTemplate` with an `onPage` callback so it applies uniformly.
6. **Write mode: confidentiality stamp where applicable.** Same red bold "STRICTLY CONFIDENTIAL" treatment as `/docx`, applied via the page template so it appears on every page.
7. **Anonymisation discipline carries over from /docx.** Teasers go to potential buyers under no-name-screen rules; the real company name must never appear. Codename only.
8. **Output naming: `<Codename>_<Type>_<YYYYMMDD>.pdf`.** Same convention as `/xlsx` and `/docx`.
9. **For docx→pdf conversion, do not invent a path.** `python-docx` cannot directly render to PDF. If the parent skill needs the PDF version of a docx, surface this to the user: "Open `<file>.docx` in Word and File → Save As → PDF, or install LibreOffice and run `libreoffice --headless --convert-to pdf <file>.docx`." Do not try to render docx→pdf in-skill.
10. **Verify before claiming done.** For write: open the saved PDF with `pypdf` and assert page count matches plan, every page has text, codename appears, confidentiality stamp appears (where required). For read: re-open the source and confirm the extracted quotes match what's on the cited pages.

---

## Workflow — Read mode

### R1. Confirm what the user wants extracted

Section by section, page range, all text, specific tables. The parent skill or the user's prompt specifies. If unclear, **ask**.

### R2. Verify the toolchain

```bash
python3 -c "import pypdf; print(pypdf.__version__)"
```

If `ModuleNotFoundError`:

> "This skill needs Python 3.10+ with `pypdf`. Run `python3 -m pip install --user pypdf` once, then retry."

### R3. Extract

```python
from pypdf import PdfReader

reader = PdfReader('/path/to/source.pdf')
for i, page in enumerate(reader.pages, start=1):
    text = page.extract_text() or ''
    if 'Risk Factors' in text:
        print(f'--- p.{i} (Risk Factors detected) ---')
        print(text)
```

For tables, `pypdf` returns text without preserving column structure reliably. If the parent skill needs structured tables, use `pdfplumber` (`python3 -m pip install --user pdfplumber`) and call out the additional dep:

```python
import pdfplumber
with pdfplumber.open('/path/to/source.pdf') as pdf:
    for i, page in enumerate(pdf.pages, start=1):
        for table in page.extract_tables():
            # table is a list[list[str]]; first row often headers
            print(f'p.{i} — table with {len(table)} rows')
```

### R4. Cite verbatim

For every extracted quote, the agent's response carries:

> "Operating margin contracted to 23.4% in FY2024 from 25.1% in FY2023, reflecting…"
> *(<file>, p. 32, MD&A — Operating Results)*

Page number is 1-indexed in the citation.

### R5. Surface findings

Return to the parent skill with:
- The extracted material (quoted, page-numbered).
- A one-line summary of where each item came from.
- Any pages where extraction failed (image-only PDFs, encrypted pages) flagged.

---

## Workflow — Write mode

### W1. Confirm the parent's layout brief

The parent skill specifies:
- Page count (1-2 pages typical for teaser, fact sheet).
- Per-page content (headline, body sections, exhibit, footer).
- Codename, date, confidentiality stamp.
- Output path and filename.

### W2. Verify the toolchain

```bash
python3 -c "import reportlab; print(reportlab.Version)"
```

If `ModuleNotFoundError`:

> "This skill needs Python 3.10+ with `reportlab`. Run `python3 -m pip install --user reportlab` once, then retry."

### W3. Build with a page template

```python
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor, red
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
)
from reportlab.platypus.frames import Frame
from reportlab.platypus.doctemplate import PageTemplate, BaseDocTemplate

NAVY = HexColor('#0A2A4A')
ACCENT = HexColor('#D4A017')
MUTED = HexColor('#888888')

def header_footer(canvas, doc):
    canvas.saveState()
    # Header — codename + confidentiality
    canvas.setFont('Helvetica-Bold', 9)
    canvas.setFillColor(NAVY)
    canvas.drawString(0.75*inch, LETTER[1] - 0.5*inch, 'PROJECT ATLAS')
    canvas.setFont('Helvetica-Bold', 9)
    canvas.setFillColor(red)
    canvas.drawRightString(LETTER[0] - 0.75*inch, LETTER[1] - 0.5*inch, 'STRICTLY CONFIDENTIAL')
    # Footer — page number
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(MUTED)
    canvas.drawCentredString(LETTER[0]/2, 0.5*inch, f'Page {doc.page}')
    canvas.restoreState()

doc = BaseDocTemplate(
    '/path/from/parent/<Codename>_Teaser_<YYYYMMDD>.pdf',
    pagesize=LETTER,
    leftMargin=0.75*inch, rightMargin=0.75*inch,
    topMargin=1.0*inch, bottomMargin=0.75*inch,
)
frame = Frame(
    0.75*inch, 0.75*inch,
    LETTER[0] - 1.5*inch, LETTER[1] - 1.75*inch,
    showBoundary=0,
)
doc.addPageTemplates([PageTemplate(id='body', frames=[frame], onPage=header_footer)])

styles = getSampleStyleSheet()
H1 = ParagraphStyle('H1', parent=styles['Heading1'], textColor=NAVY, fontSize=18, spaceAfter=8)
BODY = ParagraphStyle('Body', parent=styles['BodyText'], fontSize=10, leading=13, spaceAfter=6)

flow = []
flow.append(Paragraph('A leading specialty industrials platform', H1))
flow.append(Paragraph(
    'The Company is a North American manufacturer of …',
    BODY,
))
# Tables, exhibits, etc.
data = [
    ['', 'FY2022', 'FY2023', 'FY2024'],
    ['Revenue ($M)', '420', '465', '510'],
    ['EBITDA ($M)', '78', '92', '110'],
    ['Margin %', '18.6%', '19.8%', '21.6%'],
]
tbl = Table(data, colWidths=[1.4*inch, 1.0*inch, 1.0*inch, 1.0*inch])
tbl.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), NAVY),
    ('TEXTCOLOR', (0, 0), (-1, 0), HexColor('#FFFFFF')),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),
    ('GRID', (0, 0), (-1, -1), 0.25, MUTED),
    ('FONTSIZE', (0, 0), (-1, -1), 9),
]))
flow.append(tbl)
flow.append(Spacer(1, 0.2*inch))
flow.append(Paragraph(
    'Source: Company management financials (unaudited); Ownware analysis.',
    ParagraphStyle('Source', parent=BODY, fontSize=8, textColor=MUTED, italic=True),
))

doc.build(flow)
```

### W4. Anonymisation pass for teasers

For `/teaser` and any pre-NDA distribution, walk the rendered PDF text and assert the real name absent:

```python
from pypdf import PdfReader
reader = PdfReader('/path/to/output.pdf')
real = 'Acme Corporation'
for i, page in enumerate(reader.pages, start=1):
    text = page.extract_text() or ''
    if real.lower() in text.lower():
        raise SystemExit(f'leak: real name on p.{i}')
```

A leak in a teaser ends a process. Non-negotiable check.

### W5. Verify

```python
reader = PdfReader('<path>')
assert len(reader.pages) == EXPECTED_PAGES
for i, page in enumerate(reader.pages, start=1):
    txt = page.extract_text() or ''
    assert 'STRICTLY CONFIDENTIAL' in txt, f'p.{i} missing confidentiality stamp'
print('OK')
```

### W6. Surface the path

Return path + page count + flagged caveats.

---

<correct_patterns>

### Read — verbatim quote with 1-indexed citation

```python
from pypdf import PdfReader
reader = PdfReader('/tmp/aapl_10k.pdf')
for i, page in enumerate(reader.pages, start=1):  # 1-indexed!
    text = page.extract_text() or ''
    if 'Operating margin' in text:
        snippet = text[text.find('Operating margin'):text.find('Operating margin')+200]
        print(f'p.{i}: "{snippet}"')
```

The agent's response then quotes verbatim with `(file, p.32, …)`.

### Write — header/footer wired via page template

```python
def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('Helvetica-Bold', 9)
    canvas.drawString(0.75*inch, LETTER[1] - 0.5*inch, 'PROJECT ATLAS')
    canvas.drawCentredString(LETTER[0]/2, 0.5*inch, f'Page {doc.page}')
    canvas.restoreState()

doc.addPageTemplates([PageTemplate(id='body', frames=[frame], onPage=header_footer)])
```

Every page rendered with `BaseDocTemplate` gets the same header and footer; you never repeat the layout code.

### Write — table style that prints

```python
TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), NAVY),       # header row
    ('TEXTCOLOR', (0, 0), (-1, 0), HexColor('#FFFFFF')),
    ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),         # numeric columns right-aligned
    ('GRID', (0, 0), (-1, -1), 0.25, MUTED),
    ('FONTSIZE', (0, 0), (-1, -1), 9),
])
```

Header dark, numeric columns right-aligned, thin grid in muted gray. Reads cleanly on a printed page.

### Confidentiality stamp on every page (via header_footer)

```python
canvas.setFont('Helvetica-Bold', 9)
canvas.setFillColor(red)
canvas.drawRightString(LETTER[0] - 0.75*inch, LETTER[1] - 0.5*inch, 'STRICTLY CONFIDENTIAL')
```

Right-justified header, red, bold. Combined with the anonymisation pass at end of build, the teaser is safe to send.

</correct_patterns>

<common_mistakes>

### WRONG: paraphrasing as extracted text

```python
# Source PDF said: "Margin compressed 170 bps to 23.4%"
# Agent paraphrased: "Margins fell"
# Then cited as if extracted: "p.32: 'Margins fell'"
```

The user cannot verify "Margins fell" against the original because that string isn't in the original. Always quote verbatim or do not put it in quotation marks.

### WRONG: zero-indexed page numbers in the citation

```python
for i, page in enumerate(reader.pages):  # i starts at 0
    print(f'p.{i}')   # the source's page 1 cites as 'p.0'
```

Convert at the boundary — `enumerate(..., start=1)` — or the citations look wrong.

### WRONG: reportlab without a page template

```python
doc = SimpleDocTemplate('/path.pdf', pagesize=LETTER)
doc.build(flow)
# no header, no footer, no page numbers
```

Page numbers and confidentiality stamp must come from a `PageTemplate.onPage` callback. Without it, every page is naked.

### WRONG: docx → pdf conversion attempt without a tool

```python
from docx import Document
d = Document('source.docx')
d.save('output.pdf')   # python-docx does not render PDFs
```

Doesn't work. Surface the LibreOffice / Word manual export instruction; do not pretend to convert.

### WRONG: real name leaks in teaser

```python
# Teaser body
flow.append(Paragraph('Acme Corp manufactures industrial valves.', BODY))
```

Teasers ship pre-NDA. Real names disqualify the deal. Anonymise everywhere; verify with a post-render scan.

### TOP 5 ERRORS

1. Paraphrasing source text and then citing it as a verbatim quote (the user cannot verify)
2. Zero-indexed page numbers in the citation (reader sees "p.0", real page is 1)
3. Building reportlab PDFs without a `PageTemplate` (no header/footer/page numbers)
4. Trying to render docx → pdf in-skill (`python-docx` does not do this; surface a manual step instead)
5. Real name leaking in teaser-class output (anonymisation pass missing)

</common_mistakes>

---

## Quality Rubric

Every PDF (read or write) must maximise for:

1. **Read: verbatim fidelity.** Every quoted snippet matches the source character-for-character.
2. **Read: 1-indexed citations.** Page numbers reflect what the reader sees, not what `pypdf` returns internally.
3. **Write: layout precision.** Margins, fonts, spacing set explicitly; no defaults relied upon.
4. **Write: page template applied.** Header, footer, page numbers, confidentiality stamp via `onPage` callback.
5. **Anonymisation enforced.** For teasers and pre-NDA materials, real-name absence verified after render.
6. **Naming convention.** `<Codename>_<Type>_<YYYYMMDD>.pdf`.

---

## Final Output Checklist

Before delivering, every item must be true:

- [ ] **Mode chosen correctly:** short layout-precise output → write mode here; long-form → `/docx`; structured workbook → `/xlsx`.
- [ ] Read mode: every extracted quote is verbatim, with 1-indexed page citation.
- [ ] Read mode: any pages where extraction failed (image-only, encrypted) flagged to the user.
- [ ] Write mode: file exists at parent-specified path with parent-specified name.
- [ ] Write mode: every page carries header (codename), footer (page number), and confidentiality stamp where required, via a `PageTemplate`.
- [ ] Write mode: tables right-align numeric columns, bold the header row, use a visible grid.
- [ ] Anonymisation pass for teaser-class output: real name absent from every rendered page.
- [ ] No attempt to render `.docx → .pdf` in-skill; surfaced the LibreOffice / Word manual step instead.
- [ ] Verification script ran without assertion errors.
- [ ] Path returned to parent with page count and any flagged caveats.
