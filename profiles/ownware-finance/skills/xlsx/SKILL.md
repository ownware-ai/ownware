---
name: xlsx
description: Generate a financial Excel workbook (.xlsx) with formulas, named ranges, number formatting, cell comments for source citations, and odd-dimensioned sensitivity tables. Use when a parent skill needs to deliver a workbook deliverable — DCF, comps, three-statement model, LBO, merger model, buyer list, portfolio review, rebalance trade list, variance table, financial plan, or any case where formulas must remain editable for the analyst to flex assumptions downstream.
trigger: /xlsx
---

# XLSX — Excel workbooks the analyst can actually flex

## Overview

A financial workbook that an MD or PM can open, audit, and stress without re-engineering. Every input is named. Every formula traces to inputs. Every sensitivity cell recalculates the full model. Source citations live in cell comments next to the number. The output file is named by the convention the parent skill specifies and saved where the parent skill says.

You produce this by writing a Python script that uses `openpyxl` (and `pandas` only if loading tabular data is more concise than building cells by hand) and running it via `shell_execute`. Do not hardcode the workbook in chat — write the script, run it, verify the file exists, then surface the path.

---

## Critical Constraints — read these first, every time

These hold regardless of model type, sector, or workbook size. Re-read before writing the script; re-check before delivering.

1. **Formulas, not values.** Cells the analyst will flex (assumptions, drivers, rates) hold values; cells that compute hold formulas. Never paste a calculated value where a formula belongs — the moment the analyst changes an input, the model must update.
2. **Named ranges for every key input.** Use openpyxl `DefinedName` for WACC, terminal growth, tax rate, the comp set's revenue multiples, etc. Formulas reference the name (`=Revenue*EBIT_Margin`), not a cell coordinate (`=B4*B5`). An analyst auditing the model should never have to chase coordinates.
3. **Number formatting on every cell.** Currency in millions: `'$#,##0.0,,"M"'`. Percent: `'0.0%'`. Multiple: `'0.0"x"'`. Whole shares: `'#,##0'`. Default General is unacceptable for finance output.
4. **Color discipline.** Blue font (`Font(color='0000FF')`) for hardcoded inputs the analyst flexes. Black for formulas. Green for cross-sheet references. Bold for headers. This is a 30-year Wall Street convention; analysts read color before they read content.
5. **Cell comments carry citations.** For every hardcoded input, attach a comment via `openpyxl.comments.Comment("<source>, <date>, <section/page>", "agent")`. The citation lives next to the number, not in a footnote sheet.
6. **Sheet structure is canonical.** Tabs in this order — `Inputs`, `Assumptions`, `Model`, `Sensitivity`, `Output`. (Add `Comps` / `Football Field` / `Sources` only when the parent skill calls for them.) Do not put everything on one sheet.
7. **Sensitivity tables recalculate the full model.** Each cell in a 5×5 sensitivity holds a formula that re-derives the implied price from the perturbed inputs. Linear approximations (`= base × (1 + Δ)`) are wrong and will be caught in review.
8. **Frozen panes, gridlines off, print area set.** `ws.freeze_panes = 'B2'` (header row + first column visible while scrolling). `ws.sheet_view.showGridLines = False`. `ws.print_area = 'A1:H40'` so a Cmd-P doesn't print 200 blank columns.
9. **File-name convention from the parent.** The parent skill (`/dcf`, `/comps`, etc.) specifies the file name. `<Ticker>_DCF_<YYYYMMDD>.xlsx`, `<Sector>_Comps_<YYYYMMDD>.xlsx`, etc. Do not invent a name.
10. **Verify before claiming done.** After running the script, open the file with `openpyxl.load_workbook(...)` in a second `shell_execute` call and assert: file exists, expected sheet names, expected named ranges, the centre sensitivity cell equals the base implied price. If any check fails, surface the failure and stop.

---

## Workflow

### Step 1 — Confirm the parent skill's contract

The parent skill (`/dcf`, `/lbo`, `/3sm`, etc.) hands you a structured payload:

- File name and output directory.
- Sheet plan (what tabs, what each contains).
- Named-range map (which inputs are flexed, what their initial values are).
- The model graph (dependencies between cells, top-down).
- Sensitivity spec (which inputs vary on which axis, in what increments).
- Citation map (which inputs have which sources).

If any of these are missing from the parent's hand-off, **stop and ask** — do not invent.

### Step 2 — Verify the Python toolchain

Before writing the workbook, confirm the environment can run the script. Run:

```bash
python3 -c "import openpyxl; print(openpyxl.__version__)"
```

If this fails with `ModuleNotFoundError`, surface a clear actionable error to the user:

> "This skill needs Python 3.10+ with `openpyxl` installed. Run `python3 -m pip install --user openpyxl pandas python-pptx python-docx pypdf` once, then retry. Ownware will bundle these libs automatically in a future release; today they're a one-time setup."

Do not silently fall back to a CSV or a markdown table. The deliverable is `.xlsx` or it is nothing.

### Step 3 — Write the build script

Write to a temp script path (e.g. `/tmp/build_<ticker>_<type>.py`). The script is the audit trail — keep it readable, named-range-driven, and commented per section.

Standard script skeleton:

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.comments import Comment
from openpyxl.utils import get_column_letter

wb = Workbook()
# remove the default sheet, then add tabs in canonical order
wb.remove(wb.active)
for tab in ['Inputs', 'Assumptions', 'Model', 'Sensitivity', 'Output']:
    wb.create_sheet(tab)

# styles defined once, reused everywhere
INPUT = Font(color='0000FF', bold=False)
FORMULA = Font(color='000000')
XREF = Font(color='006100')
HEADER = Font(bold=True)
PCT = '0.0%'
MUSD = '$#,##0.0,,"M"'
MULT = '0.0"x"'

# ... build sheets, named ranges, formulas, formatting, comments ...

wb.save('/path/from/parent/<Ticker>_<Type>_<YYYYMMDD>.xlsx')
```

### Step 4 — Run + verify

Execute the script. Then in a second `shell_execute` call, open the produced file and run sanity checks:

```python
from openpyxl import load_workbook
wb = load_workbook('<path>', data_only=False)
assert {'Inputs', 'Assumptions', 'Model', 'Sensitivity', 'Output'}.issubset(set(wb.sheetnames))
names = {dn.name for dn in wb.defined_names.definedName}
required = {'WACC', 'Terminal_Growth', 'Tax_Rate'}
assert required.issubset(names), f'missing named ranges: {required - names}'
# Centre sensitivity cell must equal base implied price
sens = wb['Sensitivity']['D5'].value  # adjust to your layout
out = wb['Output']['B10'].value
# When the file is opened in Excel the formulas evaluate; data_only=False
# returns the formula text, which we can spot-check rather than equality.
print('OK')
```

If any assertion fails, raise — do not move on.

### Step 5 — Surface the path + brief

Return to the parent skill with:
- Absolute path of the .xlsx.
- One-line summary of what's inside ("5-year DCF, Bear/Base/Bull, 3 sensitivity tables, all formulas live").
- Any caveats the build script flagged (missing inputs, source gaps).

---

<correct_patterns>

### Named ranges + formulas referencing them

```python
# Inputs sheet
ws = wb['Inputs']
ws['A1'] = 'WACC'
ws['B1'] = 0.090
ws['B1'].font = INPUT
ws['B1'].number_format = '0.00%'
ws['B1'].comment = Comment('Computed via CAPM. RFR=4.5% (FRED DGS10 2026-05-07), beta=1.10 (5Y monthly vs SPX), ERP=5.5% (Damodaran 2026 update).', 'agent')
wb.defined_names['WACC'] = DefinedName('WACC', attr_text="Inputs!$B$1")

# Model sheet uses the name, not the coordinate
ws_m = wb['Model']
ws_m['B10'] = '=PV_FCF / (1 + WACC)^(YEAR - 0.5)'
ws_m['B10'].font = FORMULA
ws_m['B10'].number_format = MUSD
```

The audit trail is the named range plus the comment. An MD scanning the model sees `WACC` in every formula and knows where it's set without searching.

### Number formatting per cell type

```python
ws['B5'].number_format = '$#,##0.0,,"M"'   # $1,234.5M
ws['B6'].number_format = '0.0%'            # 24.3%
ws['B7'].number_format = '0.0"x"'          # 12.4x
ws['B8'].number_format = '#,##0'           # 1,234
ws['B9'].number_format = '$#,##0.00'       # $123.45 (per-share)
```

Default General formatting on a financial deliverable looks amateur; an MD will read this in 30 seconds and form an opinion of you.

### Sensitivity table — full DCF recalc per cell

```python
ws_s = wb['Sensitivity']
ws_s['A1'] = 'Implied Price ($), WACC × Terminal Growth'
ws_s['A1'].font = HEADER

# WACC values down column A, terminal-g values across row 1
waccs = [0.080, 0.085, 0.090, 0.095, 0.100]
gs = [0.020, 0.025, 0.030, 0.035, 0.040]
for i, w in enumerate(waccs, start=3):
    ws_s.cell(row=i, column=1, value=w).number_format = '0.00%'
for j, g in enumerate(gs, start=2):
    ws_s.cell(row=2, column=j, value=g).number_format = '0.00%'

# Each interior cell holds a formula that recomputes implied price
# using the perturbed WACC + g. Reference inputs by name in the formula
# so the table never goes stale when other assumptions change.
for i, w in enumerate(waccs, start=3):
    for j, g in enumerate(gs, start=2):
        wacc_addr = ws_s.cell(row=i, column=1).coordinate
        g_addr = ws_s.cell(row=2, column=j).coordinate
        formula = (
            f"=(SUM(Model!$B$10:$B$14) + "
            f"INDEX(Model!$B$15,1)*(1+{g_addr})/({wacc_addr}-{g_addr})/((1+{wacc_addr})^4.5)"
            f" + Net_Cash) / Diluted_Shares"
        )
        ws_s.cell(row=i, column=j, value=formula).number_format = '$#,##0.00'

# Highlight the centre cell
center = ws_s.cell(row=5, column=4)
center.fill = PatternFill('solid', fgColor='FFEB9C')
```

Every cell is a real formula; flexing any other input on `Inputs` ripples through the table.

### Cell comments for citations

```python
ws['B12'] = 383300.0
ws['B12'].font = INPUT
ws['B12'].number_format = MUSD
ws['B12'].comment = Comment(
    'AAPL FY2024 10-K, p. 32, Consolidated Statements of Operations',
    'agent',
)
```

The MD hovers, sees the source. No separate sources sheet to chase.

### Output convention

```python
import os
from datetime import date
output_dir = os.path.expanduser('~/Desktop')  # parent specifies
ticker = 'AAPL'
kind = 'DCF'
filename = f'{ticker}_{kind}_{date.today().strftime("%Y%m%d")}.xlsx'
wb.save(f'{output_dir}/{filename}')
print(f'wrote {filename}')
```

Filename is parseable, sortable, and self-describing. Multiple builds the same day overwrite — that's intentional; if the user wants to keep both, they rename.

</correct_patterns>

<common_mistakes>

### WRONG: hardcoding computed values

```python
ws['B10'] = 415900.0   # FY25E revenue, "calculated already in chat"
```

The moment the analyst changes the growth assumption, this cell does not update. Sensitivity tables built downstream are wrong. Every formula must live in the cell.

Correct:

```python
ws['B10'] = '=Revenue_LTM * (1 + Growth_Y1)'
ws['B10'].font = FORMULA
ws['B10'].number_format = MUSD
```

### WRONG: defaulting to General number format

```python
ws['B5'] = 0.0903   # WACC, no format
```

Renders as `0.0903`. An MD looks at this and assumes raw dump. Apply `'0.00%'`.

### WRONG: linear sensitivity

```python
# Each cell adjusts the base by a delta — NOT a real DCF
formula = f'=Base_Price * (1 + ({wacc_addr} - WACC) / WACC * -3.5)'
```

The `-3.5` is a back-of-the-envelope duration estimate. The cell is not a real recalc. Real sensitivity is non-linear; this lies to the reader.

### WRONG: missing comments on inputs

```python
ws['B12'] = 383300.0
ws['B12'].number_format = MUSD
# (no comment)
```

The number floats without a source. In review, no one can defend it. Every hardcoded input gets a `Comment`.

### WRONG: everything on one sheet

```python
ws = wb.active
# rows 1-200 hold inputs, model, sensitivity, output, sources, scratch
```

Unreadable. Print breaks across pages mid-section. Frozen panes don't help. Stick to the canonical 5 tabs.

### TOP 5 ERRORS

1. Hardcoded values where formulas should be (kills sensitivity, kills audit)
2. Default number format (looks unfinished; reader assumption is "draft")
3. Linear / shortcut sensitivity instead of full recalc per cell
4. No cell comments — citations get lost the moment the file is shared
5. Single-sheet dumps instead of canonical Inputs / Assumptions / Model / Sensitivity / Output

</common_mistakes>

---

## Quality Rubric

Every workbook must maximise for:

1. **Live formulas** — every flexable input ripples through the entire model when changed.
2. **Named ranges** — formulas read like English (`=Revenue*EBIT_Margin`), not coordinates.
3. **Format discipline** — currency, percent, multiple, share counts each in their proper format.
4. **Color discipline** — blue inputs, black formulas, green cross-refs, bold headers.
5. **Citation density** — every hardcoded input has a comment naming the source.
6. **Canonical structure** — 5 tabs, consistent across every workbook the agent produces.
7. **Sensitivity rigor** — odd-dimensioned tables, centre cell highlighted, every cell a full recalc, centre value equals base case.

---

## Final Output Checklist

Before declaring the workbook delivered, every item must be true:

- [ ] File exists at the path the parent skill specified.
- [ ] File name follows `<Ticker>_<Type>_<YYYYMMDD>.xlsx` or the parent's stated convention.
- [ ] All canonical tabs present (Inputs, Assumptions, Model, Sensitivity, Output) plus any parent-specified extras.
- [ ] Every flexable input is a named range; no formula references a raw coordinate where a name would do.
- [ ] Every cell that holds money / percent / multiple / shares carries the right number format.
- [ ] Color discipline applied (blue inputs, black formulas, green cross-refs).
- [ ] Every hardcoded input has a `Comment` naming the source and date.
- [ ] Sensitivity tables are odd-dimensioned (5×5 standard); centre cell highlighted; centre cell formula equals the base case implied output.
- [ ] Frozen panes set, gridlines off, print area set.
- [ ] Verification script ran without assertion errors.
- [ ] Path returned to the parent skill with one-line summary and any flagged caveats.
