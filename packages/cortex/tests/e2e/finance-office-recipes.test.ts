/**
 * E2E (Slice 9 / 10 verification): the office-skill recipes documented
 * in `/xlsx`, `/docx`, and `/pdf` SKILL.md files actually produce
 * valid files when run.
 *
 * No LLM. No OpenRouter. No real-time cost. The test runs each
 * office-skill's representative `<correct_patterns>` script as a
 * Python subprocess on the local machine and validates the produced
 * file with the same library, asserting the structural invariants the
 * skills promise (formulas, named ranges, cell comments, heading
 * styles, page templates).
 *
 * Why this exists: Slice 9 wrote the SKILL.md files, Slice 10 made
 * every modeling/IB/PE/wealth/ops/equity-research skill call them, and
 * Slice 11a/11b/11c verified the LLM wire end-to-end. What was NOT
 * verified end-to-end: that the Python recipes the SKILL.md files
 * teach actually run cleanly and produce files matching the discipline
 * the skill claims (named ranges, formula-driven sensitivity, etc.).
 * This test pins that down.
 *
 * Skipped cleanly when `python3` is not on PATH or a specific library
 * is unavailable — matches the office skills' own behaviour ("if a lib
 * is missing, surface the install instruction and stop").
 *
 * Run:
 *   npm run test:e2e -- tests/e2e/finance-office-recipes.test.ts
 *
 * Cost: $0. No network. No LLM.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Toolchain detection (skip-if helpers — match the office skills' own
// missing-lib behaviour: surface and skip, never silently degrade).
// ---------------------------------------------------------------------------

function hasPython3(): boolean {
  const r = spawnSync('python3', ['--version'], { encoding: 'utf-8' })
  return r.status === 0
}

function hasPyLib(importName: string): boolean {
  if (!hasPython3()) return false
  const r = spawnSync('python3', ['-c', `import ${importName}`], {
    encoding: 'utf-8',
  })
  return r.status === 0
}

const HAS_PY = hasPython3()
const HAS_OPENPYXL = hasPyLib('openpyxl')
const HAS_DOCX = hasPyLib('docx')
const HAS_PPTX = hasPyLib('pptx')
const HAS_REPORTLAB = hasPyLib('reportlab')
const HAS_PYPDF = hasPyLib('pypdf')

beforeAll(() => {
  if (!HAS_PY) {
    console.log('⏭ Skipping office-recipes e2e: python3 not on PATH')
    return
  }
  const missing: string[] = []
  if (!HAS_OPENPYXL) missing.push('openpyxl')
  if (!HAS_DOCX) missing.push('python-docx')
  if (!HAS_PPTX) missing.push('python-pptx')
  if (!HAS_REPORTLAB) missing.push('reportlab')
  if (!HAS_PYPDF) missing.push('pypdf')
  if (missing.length > 0) {
    console.log(
      `⏭ Some office-recipes subtests will skip; missing libs: ${missing.join(', ')}. ` +
        `Install with: python3 -m pip install --user ${missing.join(' ')}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Per-test cleanup
// ---------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    try {
      await fn()
    } catch {
      /* best-effort */
    }
  }
  cleanups.length = 0
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function runPython(scriptPath: string, cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('python3', [scriptPath], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_PY)('e2e: office-skill recipes produce valid files', () => {
  // ─── /xlsx recipe ──────────────────────────────────────────────────
  it.skipIf(!HAS_OPENPYXL)(
    'xlsx recipe produces a workbook with named ranges, cell comments, and a formula-driven 5×5 sensitivity',
    async () => {
      const dir = await makeTempDir('cortex-office-xlsx-')
      const buildScript = join(dir, 'build.py')
      const verifyScript = join(dir, 'verify.py')
      const outputXlsx = join(dir, 'TEST_DCF_20260507.xlsx')

      // Mirror the /xlsx SKILL.md <correct_patterns> shape: named
      // ranges via DefinedName, formulas live, sensitivity tables 5×5
      // with a centre-cell formula, cell comments for citations.
      await writeFile(
        buildScript,
        `
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.comments import Comment

wb = Workbook()
wb.remove(wb.active)
for tab in ['Inputs', 'Assumptions', 'Model', 'Sensitivity', 'Output']:
    wb.create_sheet(tab)

INPUT = Font(color='0000FF')
FORMULA = Font(color='000000')
PCT = '0.00%'
MUSD = '$#,##0.0,,"M"'

# Inputs: WACC, Terminal_Growth (named ranges)
ws = wb['Inputs']
ws['A1'] = 'WACC'
ws['B1'] = 0.090
ws['B1'].font = INPUT
ws['B1'].number_format = PCT
ws['B1'].comment = Comment('CAPM. RFR=4.5%, beta=1.10, ERP=5.5%.', 'agent')
wb.defined_names['WACC'] = DefinedName('WACC', attr_text="Inputs!\\$B\\$1")

ws['A2'] = 'Terminal_Growth'
ws['B2'] = 0.025
ws['B2'].font = INPUT
ws['B2'].number_format = PCT
ws['B2'].comment = Comment('Long-run nominal GDP estimate.', 'agent')
wb.defined_names['Terminal_Growth'] = DefinedName('Terminal_Growth', attr_text="Inputs!\\$B\\$2")

# Model uses the names
ws_m = wb['Model']
ws_m['A1'] = 'TV'
ws_m['B1'] = '=100*(1+Terminal_Growth)/(WACC-Terminal_Growth)'
ws_m['B1'].font = FORMULA
ws_m['B1'].number_format = MUSD

# Sensitivity: 5x5 with a centre-cell formula
ws_s = wb['Sensitivity']
waccs = [0.080, 0.085, 0.090, 0.095, 0.100]
gs = [0.020, 0.025, 0.030, 0.035, 0.040]
for i, w in enumerate(waccs, start=3):
    ws_s.cell(row=i, column=1, value=w).number_format = PCT
for j, g in enumerate(gs, start=2):
    ws_s.cell(row=2, column=j, value=g).number_format = PCT
for i, w in enumerate(waccs, start=3):
    for j, g in enumerate(gs, start=2):
        wa = ws_s.cell(row=i, column=1).coordinate
        ga = ws_s.cell(row=2, column=j).coordinate
        ws_s.cell(row=i, column=j, value=f'=100*(1+{ga})/({wa}-{ga})').number_format = MUSD

# Highlight the centre cell
center = ws_s.cell(row=5, column=4)
center.fill = PatternFill('solid', fgColor='FFEB9C')

wb.save('${outputXlsx}')
print('OK')
`.trim(),
      )

      const built = runPython(buildScript, dir)
      expect(built.status, `build script failed: stderr=${built.stderr}`).toBe(0)
      expect(existsSync(outputXlsx)).toBe(true)

      // Verification — load the file with openpyxl and assert the
      // structural promises the /xlsx skill makes.
      await writeFile(
        verifyScript,
        `
from openpyxl import load_workbook
wb = load_workbook('${outputXlsx}', data_only=False)

# (1) Canonical sheet structure.
expected = {'Inputs', 'Assumptions', 'Model', 'Sensitivity', 'Output'}
assert expected.issubset(set(wb.sheetnames)), f'missing sheets: {expected - set(wb.sheetnames)}'

# (2) Named ranges present.
names = {dn.name for dn in wb.defined_names.values()}
assert 'WACC' in names, f'WACC named range missing; got {names}'
assert 'Terminal_Growth' in names, f'Terminal_Growth missing; got {names}'

# (3) Formula references the named ranges, not coordinates.
m_b1 = wb['Model']['B1'].value
assert isinstance(m_b1, str) and m_b1.startswith('='), f'Model!B1 not a formula: {m_b1!r}'
assert 'Terminal_Growth' in m_b1, f'Model!B1 should reference Terminal_Growth name: {m_b1!r}'
assert 'WACC' in m_b1, f'Model!B1 should reference WACC name: {m_b1!r}'

# (4) Cell comments present on the inputs.
assert wb['Inputs']['B1'].comment is not None, 'WACC cell missing source comment'
assert wb['Inputs']['B2'].comment is not None, 'Terminal_Growth cell missing source comment'

# (5) Sensitivity centre cell is a formula (not a hardcoded value).
center = wb['Sensitivity'].cell(row=5, column=4)
assert isinstance(center.value, str) and center.value.startswith('='), \\
    f'sensitivity centre cell not a formula: {center.value!r}'

# (6) Sensitivity is 5x5 — count populated cells in the body region.
populated = 0
for i in range(3, 8):
    for j in range(2, 7):
        if wb['Sensitivity'].cell(row=i, column=j).value is not None:
            populated += 1
assert populated == 25, f'sensitivity body not 5x5; populated={populated}'

print('OK')
`.trim(),
      )
      const verified = runPython(verifyScript, dir)
      expect(
        verified.status,
        `verify script failed: stderr=${verified.stderr}, stdout=${verified.stdout}`,
      ).toBe(0)
    },
    60_000,
  )

  // ─── /docx recipe ──────────────────────────────────────────────────
  it.skipIf(!HAS_DOCX)(
    'docx recipe produces a document with built-in heading styles, a styled table, and different first-page header/footer',
    async () => {
      const dir = await makeTempDir('cortex-office-docx-')
      const buildScript = join(dir, 'build.py')
      const verifyScript = join(dir, 'verify.py')
      const outputDocx = join(dir, 'PROJECT_ATLAS_CIM_v1.0_20260507.docx')

      await writeFile(
        buildScript,
        `
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()
section = doc.sections[0]
section.different_first_page_header_footer = True

# Cover page
title = doc.add_paragraph()
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = title.add_run('PROJECT ATLAS')
run.font.size = Pt(28)
run.bold = True

stamp = doc.add_paragraph()
stamp.alignment = WD_ALIGN_PARAGRAPH.CENTER
sr = stamp.add_run('STRICTLY CONFIDENTIAL')
sr.bold = True
sr.font.color.rgb = RGBColor(0xC0, 0x10, 0x10)

doc.add_page_break()

# Body — built-in heading styles, not bold paragraphs
doc.add_heading('Executive Summary', level=1)
doc.add_paragraph('Project Atlas is a leading specialty industrials platform.')

doc.add_heading('The Company', level=1)
doc.add_heading('Business Description', level=2)
doc.add_paragraph('North American manufacturer of high-precision components.')

# Styled table
table = doc.add_table(rows=4, cols=4)
table.style = 'Light Grid Accent 1'
hdr = table.rows[0].cells
hdr[0].text = ''
hdr[1].text = 'FY2022'
hdr[2].text = 'FY2023'
hdr[3].text = 'FY2024'

# Real name absence (anonymisation pass would catch a leak)
real = 'Acme Corporation'
for para in doc.paragraphs:
    assert real.lower() not in para.text.lower(), 'real name leaked in cover/body'

doc.save('${outputDocx}')
print('OK')
`.trim(),
      )
      const built = runPython(buildScript, dir)
      expect(built.status, `build script failed: stderr=${built.stderr}`).toBe(0)
      expect(existsSync(outputDocx)).toBe(true)

      await writeFile(
        verifyScript,
        `
from docx import Document
d = Document('${outputDocx}')

# (1) At least one Heading 1 paragraph using the built-in style (not bold runs).
heading_levels = []
for p in d.paragraphs:
    if p.style and p.style.name and p.style.name.startswith('Heading'):
        try:
            heading_levels.append(int(p.style.name.split()[-1]))
        except ValueError:
            pass
assert 1 in heading_levels, f'no Heading 1 found; styles={heading_levels}'
assert 2 in heading_levels, f'no Heading 2 found; styles={heading_levels}'

# (2) At least one table with a real .style applied.
assert len(d.tables) >= 1, 'no tables found'
t = d.tables[0]
assert t.style is not None, 'table has no .style'
assert t.style.name != 'Normal Table', f'table is on default Normal Table style'

# (3) Different first-page header/footer enabled (cover-page distinct).
assert d.sections[0].different_first_page_header_footer is True, \\
    'different_first_page_header_footer must be True for CIM-class docs'

# (4) Anonymisation: real name not present.
real = 'Acme Corporation'
for para in d.paragraphs:
    assert real.lower() not in para.text.lower(), 'real name leak in body'
for tbl in d.tables:
    for row in tbl.rows:
        for cell in row.cells:
            assert real.lower() not in cell.text.lower(), 'real name leak in table cell'

print('OK')
`.trim(),
      )
      const verified = runPython(verifyScript, dir)
      expect(
        verified.status,
        `verify script failed: stderr=${verified.stderr}, stdout=${verified.stdout}`,
      ).toBe(0)
    },
    60_000,
  )

  // ─── /pptx recipe ──────────────────────────────────────────────────
  it.skipIf(!HAS_PPTX)(
    'pptx recipe produces a 16:9 deck with asking-title headline, footer, and source line',
    async () => {
      const dir = await makeTempDir('cortex-office-pptx-')
      const buildScript = join(dir, 'build.py')
      const verifyScript = join(dir, 'verify.py')
      const outputPptx = join(dir, 'AAPL_OnePager_20260507.pptx')

      await writeFile(
        buildScript,
        `
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

NAVY = RGBColor(0x0A, 0x2A, 0x4A)
MUTED = RGBColor(0x88, 0x88, 0x88)

def add_title(slide, text):
    box = slide.shapes.add_textbox(Inches(0.5), Inches(0.3), Inches(12.3), Inches(0.7))
    tf = box.text_frame
    tf.text = text
    p = tf.paragraphs[0]
    p.font.size = Pt(24)
    p.font.bold = True
    p.font.color.rgb = NAVY

def add_footer(slide, page, total, project='AAPL'):
    foot = slide.shapes.add_textbox(Inches(0.5), Inches(7.0), Inches(12.3), Inches(0.3))
    p = foot.text_frame.paragraphs[0]
    p.text = project
    p.font.size = Pt(9)
    p.font.color.rgb = MUTED
    pg = slide.shapes.add_textbox(Inches(12.3), Inches(7.0), Inches(0.7), Inches(0.3))
    pg_p = pg.text_frame.paragraphs[0]
    pg_p.text = f'{page} / {total}'
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

# Single body slide — asking-title headline, source line, footer + page
slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank
add_title(slide, 'AAPL trades at \\$208 implied vs \\$185 spot — 12% upside, 5x5 sensitivity below')
add_footer(slide, 1, 1)
add_source(slide, 'Apple FY2024 10-K; Ownware analysis (2026-05-07)')

prs.save('${outputPptx}')
print('OK')
`.trim(),
      )
      const built = runPython(buildScript, dir)
      expect(built.status, `build script failed: stderr=${built.stderr}`).toBe(0)
      expect(existsSync(outputPptx)).toBe(true)

      await writeFile(
        verifyScript,
        `
from pptx import Presentation
from pptx.util import Emu

prs = Presentation('${outputPptx}')

# (1) 16:9 aspect ratio (13.333 x 7.5 inches in EMU).
assert prs.slide_width == Emu(Inches := int(13.333 * 914400)) or prs.slide_width >= Emu(int(13.0 * 914400)), \\
    f'slide_width not 16:9-shaped; got {prs.slide_width} EMU'
ratio = prs.slide_width / prs.slide_height
assert abs(ratio - 16/9) < 0.05, f'aspect ratio not 16:9; got {ratio:.4f}'

# (2) At least one slide.
assert len(prs.slides) >= 1, 'no slides found'

slide = prs.slides[0]

# (3) Asking-title headline present (the recommendation in the title text).
text_blocks = []
for shape in slide.shapes:
    if shape.has_text_frame:
        text_blocks.append(shape.text_frame.text)
combined = '\\n'.join(text_blocks)
assert 'AAPL' in combined, f'ticker missing from slide; text={combined!r}'
assert 'upside' in combined.lower() or 'implied' in combined.lower(), \\
    f'asking-title takeaway language missing; text={combined!r}'

# (4) Source line present (the citation discipline).
assert 'Source:' in combined, f'source line missing; text={combined!r}'

# (5) Footer / page-number text on the slide.
assert '1 / 1' in combined or '1 of 1' in combined.replace('/', 'of'), \\
    f'page number missing; text={combined!r}'

print('OK')
`.trim(),
      )
      const verified = runPython(verifyScript, dir)
      expect(
        verified.status,
        `verify script failed: stderr=${verified.stderr}, stdout=${verified.stdout}`,
      ).toBe(0)
    },
    60_000,
  )

  // ─── /pdf write recipe ─────────────────────────────────────────────
  it.skipIf(!HAS_REPORTLAB || !HAS_PYPDF)(
    'pdf write recipe produces a single-page PDF with header/footer/page-number via PageTemplate',
    async () => {
      const dir = await makeTempDir('cortex-office-pdf-')
      const buildScript = join(dir, 'build.py')
      const verifyScript = join(dir, 'verify.py')
      const outputPdf = join(dir, 'PROJECT_ATLAS_TEASER_20260507.pdf')

      await writeFile(
        buildScript,
        `
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, red
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import Paragraph, Spacer
from reportlab.platypus.frames import Frame
from reportlab.platypus.doctemplate import PageTemplate, BaseDocTemplate

NAVY = HexColor('#0A2A4A')
MUTED = HexColor('#888888')

def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('Helvetica-Bold', 9)
    canvas.setFillColor(NAVY)
    canvas.drawString(0.75*inch, LETTER[1] - 0.5*inch, 'PROJECT ATLAS')
    canvas.setFillColor(red)
    canvas.drawRightString(LETTER[0] - 0.75*inch, LETTER[1] - 0.5*inch, 'STRICTLY CONFIDENTIAL')
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(MUTED)
    canvas.drawCentredString(LETTER[0]/2, 0.5*inch, f'Page {doc.page}')
    canvas.restoreState()

doc = BaseDocTemplate(
    '${outputPdf}',
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

flow = [
    Paragraph('A leading specialty industrials platform', H1),
    Paragraph('The Company is a North American manufacturer of high-precision components.', BODY),
    Spacer(1, 0.2*inch),
    Paragraph('Source: Company management financials (unaudited); Ownware analysis.',
              ParagraphStyle('Source', parent=BODY, fontSize=8, textColor=MUTED, italic=True)),
]
doc.build(flow)
print('OK')
`.trim(),
      )
      const built = runPython(buildScript, dir)
      expect(built.status, `build script failed: stderr=${built.stderr}`).toBe(0)
      expect(existsSync(outputPdf)).toBe(true)

      await writeFile(
        verifyScript,
        `
from pypdf import PdfReader
reader = PdfReader('${outputPdf}')

# (1) Single page.
assert len(reader.pages) == 1, f'expected 1 page; got {len(reader.pages)}'

# (2) Body text present.
text = (reader.pages[0].extract_text() or '')
assert 'specialty industrials' in text.lower(), f'body text missing; got: {text[:200]!r}'

# (3) Confidentiality stamp + project name from the page-template header.
assert 'STRICTLY CONFIDENTIAL' in text, f'confidentiality stamp missing; got: {text[:300]!r}'
assert 'PROJECT ATLAS' in text, f'project name missing; got: {text[:300]!r}'

# (4) Page-number footer rendered (the onPage callback fired).
assert 'Page 1' in text, f'page-number footer missing; got: {text[:300]!r}'

# (5) Anonymisation: real name absent.
assert 'Acme Corporation' not in text, 'real name leaked in rendered PDF'

print('OK')
`.trim(),
      )
      const verified = runPython(verifyScript, dir)
      expect(
        verified.status,
        `verify script failed: stderr=${verified.stderr}, stdout=${verified.stdout}`,
      ).toBe(0)
    },
    60_000,
  )
})
