---
name: pptx-fidelity-audit
description: 'Audit the gap between an HTML deck (from /deck) and the .pptx exported by /pptx-export. Walks a 10-point fidelity checklist (font substitution, footer rail, italic preservation, hyperlinks, image DPI, chart re-rendering, etc.) and writes audit-<deckname>.md with PASS / FAIL / PARTIAL per check + the fix. Use when the user says "verify the deck", "ppt is cut off", "fix the pptx". Skip if the HTML deck does not exist — build it with /deck first.'
trigger: /pptx-fidelity-audit
---

# PPTX Fidelity Audit — does the .pptx still look like the HTML?

## Overview

A python-pptx export silently drifts from its HTML source. Text bleeds into the footer, italic words go flat, hero slides anchor to the top instead of centering, charts re-render with the wrong axis, hyperlinks vanish. The eye misses 1–2mm overflow at zoom-out; the script doesn't. This skill is the discipline that catches the drift and ships an audit report the operator can act on.

Pairs with `/pptx-export` (this audits what that produces) and `/deck` (the HTML deck is ground truth). If either is missing, build it first — don't audit a one-sided pair.

The deliverable is a markdown file named `audit-<deckname>.md` with PASS / FAIL / PARTIAL on each of the ten checks, the specific evidence per failure, and the one-line fix.

---

## Critical Constraints — read these first, every time

1. **The HTML deck is ground truth.** When the PPTX disagrees with the HTML, the PPTX is wrong. The audit never says "the HTML should change to match the PPTX".
2. **Extract before judging.** Run an extractor over the PPTX and walk every shape on every slide before writing any verdict. Don't trust the export script's intent — trust the dump.
3. **Geometry first, glyphs second.** Most failures are positional (top + height exceeds the footer rail). Glyph issues (font substitution, italic loss) come second. Audit in this order.
4. **One audit per slide-pair, not one per shape.** The slide is the unit of comparison. A slide PASSes when all ten checks pass; PARTIAL when some pass; FAIL when any 🔴 check fails.
5. **Severity drives priority.** 🔴 critical (content cropped, off-canvas, footer overlap) must be fixed before shipping; 🟠 high (hero not centered, hierarchy broken) should fix; 🟡 medium (italic missing, hyperlink lost) fix in this pass; 🟢 low (sub-pixel offset, kerning drift) note but don't block.
6. **Never re-export silently.** The audit produces a report; the operator runs the re-export. Ownware doesn't run Python inside the agent — the user runs the script. See `/pptx-export` for the run instruction.

---

## The 10-point fidelity checklist

Walk these in order. Each check has the question, what counts as PASS / FAIL / PARTIAL, and the canonical fix.

### 1. Font substitution

**Question:** Does every text run in the PPTX use the font the HTML CSS declared? (Inter, Source Serif Pro, Noto Sans SC, JetBrains Mono, etc.)

- **PASS** — every run's `font.name` matches the CSS family for that role. Latin-script runs use Inter; serif display runs use Source Serif Pro; mono runs use JetBrains Mono.
- **PARTIAL** — one or two runs fall back to a generic (Calibri, Arial, Times New Roman). Usually because the font isn't on the rendering machine.
- **FAIL** — most runs are Calibri or Microsoft JhengHei. The export never set `font.name` explicitly.

**Fix:** in the export script, every `run.font.name = '<family>'` is explicit per run; pin a fallback list in the script header; install the fonts on the target machine (or embed via the `pptx` font-embedding XML if the audience needs portability).

### 2. Italic and em preservation

**Question:** Do `<em>` / `<i>` / `font-style: italic` spans in the HTML render as italic runs in the PPTX?

- **PASS** — every italic span in HTML has `run.font.italic = True` in the dump.
- **PARTIAL** — italic preserved on most slides but missed on the closing slide or pull-quote.
- **FAIL** — italic never propagated. Every word renders upright.

**Fix:** in the HTML → PPTX walker, detect italic spans and call `run.font.italic = True` explicitly. **Never italicize CJK / Arabic / Devanagari / Thai / Hebrew runs** — those scripts have no italic tradition and PowerPoint produces a mechanically-skewed deformation. Audit the script for `if is_latin_script(text): run.font.italic = italic`.

### 3. Footer rail / content overflow

**Question:** Does every content shape's `top + height` stay above the footer rail (`CONTENT_MAX_Y = Inches(6.70)` on a 16:9 canvas)?

- **PASS** — every content shape's bottom ≤ 6.70".
- **PARTIAL** — one slide has a body block reaching 6.72–6.85"; visible at large zoom only.
- **FAIL** — multiple slides cross the rail; on slide 5 a body bottom sits at 7.20".

**Fix:** route every block through a `Cursor` that refuses to advance past the rail (see `/pptx-export` for the helper). Hero slides use a *budget* (compute total content height, center it) instead of pinning to MARGIN_TOP. Re-export raises an `OverflowError` instead of silently emitting a bad slide.

### 4. Off-canvas content

**Question:** Does every shape fit inside the 13.333 × 7.5" canvas? `top + height ≤ 7.5"`, `left + width ≤ 13.333"`, `top ≥ 0`, `left ≥ 0`.

- **PASS** — no shape exceeds canvas bounds.
- **FAIL** — any shape extends off-canvas, even by a fraction of an inch. Off-canvas content is invisible in slideshow mode and silently truncated in PDF export.

**Fix:** clamp shape geometry at write time. The export script's `add_textbox` wrapper rejects geometries that would land off-canvas.

### 5. Layout-master / slide-master inheritance

**Question:** Are background fills, default fonts, and footer/page-number placeholders consistent across slides? Does each slide inherit from the right layout master?

- **PASS** — every slide built from layout index 6 (BLANK) with explicit per-slide background paint; no slide accidentally inherits the default Office theme.
- **PARTIAL** — most slides correct; one slide leaked the default white background (the export forgot to call `paint_background`).
- **FAIL** — half the deck inherits Office's default master with blue title placeholders and Calibri.

**Fix:** start every slide from `prs.slide_layouts[6]` (BLANK) and call `paint_background(slide, BG)` first. Never use layout 0 (TITLE) — the inherited Office title placeholder fights the manual textbox.

### 6. Image DPI and aspect

**Question:** Are images placed at the resolution the slide needs? A 200×120 px logo stretched to 8" wide will render fuzzy.

- **PASS** — every `add_picture` source image is at least 2× the rendered size (Retina-equivalent). Aspect matches the placement aspect ratio.
- **PARTIAL** — one or two images are below 2×; visible blur at projector scale.
- **FAIL** — most images are upscaled from web thumbnails; the deck looks soft.

**Fix:** source images at 2× target inch dimension × 96 DPI minimum. For an 8"-wide hero image, use a 1536px-wide source. Crop in Python before `add_picture` rather than letting PowerPoint stretch.

### 7. Chart re-rendering

**Question:** If the HTML deck has inline SVG charts (polylines, bars, axes), are the equivalents in the PPTX visually faithful — same data, same proportions, same colors?

- **PASS** — charts rebuilt with `pptx.chart` native primitives, or as a high-resolution PNG via `add_picture`. Bars match the HTML's bar heights to within 5%.
- **PARTIAL** — chart present but axis ordering reversed, or one bar's height drifted by ~15%.
- **FAIL** — chart missing, or rebuilt as a generic Office chart that doesn't match the HTML's color or shape.

**Fix:** for simple charts (≤5 bars, ≤2 lines), re-build with `pptx.chart.XL_CHART_TYPE.COLUMN_CLUSTERED` + `CategoryChartData`. For complex SVG, export the HTML chart to PNG at 2× and `add_picture` — python-pptx's SVG import is unreliable across versions.

### 8. Hyperlink preservation

**Question:** Do HTML `<a href>` links survive into clickable PPTX hyperlinks?

- **PASS** — every link in HTML has `run.hyperlink.address = '<url>'` in the PPTX dump. Email links carry the `mailto:` prefix.
- **PARTIAL** — most links preserved; one link lost (usually a button-styled CTA that the export treated as a shape, not a run).
- **FAIL** — no hyperlinks. Every `<a>` rendered as plain text.

**Fix:** when walking HTML, detect `<a href>` and call `run.hyperlink.address = href` on the run. CTAs that are buttons in HTML become a textbox with the run hyperlinked, not a shape with an unset hyperlink.

### 9. Animation and transition loss

**Question:** Did any HTML animations (CSS transitions, scroll-driven effects) survive into the PPTX? Spoiler — they don't, and that's usually fine.

- **PASS (expected)** — no animations in the PPTX. The HTML's CSS animations were decorative; their absence doesn't change the message.
- **PARTIAL** — the HTML deck had a load-driven build-out the audience expected (e.g. progressive bar reveal in a chart). Worth a callout for the operator.
- **FAIL** — the HTML deck *depended* on animation to communicate (e.g. a step-through reveal that's incoherent as a static slide). The deck needs a re-design, not an export fix.

**Fix:** for cases where animation carried meaning, split the animated slide into N static slides — one per build state. PowerPoint also supports basic build-in animations via `add_animation` XML hacks, but the multi-slide split is simpler and prints to PDF cleanly.

### 10. Tabular / mono-figure preservation

**Question:** Are numeric tables, KPI rows, and data callouts using tabular numerals (mono-figure) the way they were in HTML?

- **PASS** — numeric runs use a mono font (JetBrains Mono) or a feature-tagged Inter (`font-variant-numeric: tabular-nums` equivalent). 100M / 200M / 300M digits line up across rows.
- **PARTIAL** — most numeric callouts correct; one slide drifted to proportional Inter where digits visibly shift.
- **FAIL** — all numerics in proportional Inter. Multi-row tables look ragged.

**Fix:** in the export script, route every numeric run through `add_run(..., font='JetBrains Mono', ...)`. python-pptx doesn't expose OpenType feature tags directly, so use a mono font for numerics rather than fighting Inter's tabular variant.

---

## The audit workflow

Five steps. Don't skip any.

1. **Extract.** Run `extract_pptx.py <deck.pptx> > pptx_dump.json`. Returns per-slide, per-shape JSON with position, size, and per-run typography. Without the dump, you're guessing.
2. **Map.** Walk the HTML and produce a parallel list — for each `<section class="slide">`, capture chrome / kicker / headline / body / foot copy and `<em>` spans. Match HTML slide N to PPTX slide N positionally.
3. **Score.** Walk the 10 checks. Each check on each slide-pair gets PASS / FAIL / PARTIAL with one sentence of evidence and a severity tag.
4. **Root-cause.** Most failures share 2–3 systemic causes — "no footer rail enforced", "italic never propagated", "no explicit `font.name` per run". Name them. The re-export script fix is small once you've named the systemic cause.
5. **Write the audit file.** Save as `audit-<deckname>.md` at the deck root. The operator reads it, runs the fix, re-exports, re-runs the audit. Re-audit must show zero 🔴 and zero 🟠 before the deck ships.

---

## The audit file shape

```markdown
# Audit · acme-q3-board.pptx
Source: ./index.html (HTML deck) · ./out/acme-q3-board.pptx (export) · 12 slides

## Summary
- 4 PASS / 6 PARTIAL / 2 FAIL across 10 checks.
- 🔴 Critical issues on slides 5, 8 (footer rail crossed).
- 🟡 Italic loss across 4 slides (em spans not propagated).

## Per-check verdict

| # | Check                | Verdict   | Evidence                                                       | Severity |
|---|----------------------|-----------|----------------------------------------------------------------|----------|
| 1 | Font substitution    | PASS      | All runs use Inter / JetBrains Mono per role.                  | —        |
| 2 | Italic preservation  | FAIL      | 4 slides have `<em>` in HTML; 0 italic runs in PPTX.           | 🟡       |
| 3 | Footer rail          | FAIL      | Slide 5 body bottom 7.20" (rail 6.70"); slide 8 body 6.95".    | 🔴       |
| 4 | Off-canvas           | PASS      | All shapes within 13.333 × 7.5".                               | —        |
| 5 | Slide-master         | PARTIAL   | Slide 1 uses TITLE layout; default placeholder leaks.          | 🟠       |
| 6 | Image DPI            | PASS      | Hero image 2880px wide at 8" placement (2.4×).                 | —        |
| 7 | Chart re-rendering   | PARTIAL   | Slide 11 bar chart heights drifted ~12% from HTML.             | 🟠       |
| 8 | Hyperlinks           | FAIL      | All HTML `<a>` rendered as plain text. 14 links lost.          | 🟡       |
| 9 | Animation loss       | PASS      | No animations carried meaning; static export is faithful.      | —        |
|10 | Tabular numerals     | PARTIAL   | KPI row on slide 9 uses proportional Inter; digits unaligned.  | 🟡       |

## Root causes (systemic)
1. **No footer rail in export script.** Every content block is pinned to a hand-picked top; once content grows, slides 5 and 8 overflow. → Adopt `Cursor` pattern from `/pptx-export`.
2. **No HTML em → italic propagation.** The HTML walker reads text only. → Detect `<em>` / `<i>` spans and set `run.font.italic = True`.
3. **Hyperlinks never set.** The walker pulls textContent. → Detect `<a href>` and set `run.hyperlink.address` on the run.

## Fixes (in order)
1. (🔴) Add `Cursor` to `scripts/build-deck.py`; route slide 5 and slide 8 bodies through it.
2. (🟠) Switch slide 1 from layout 0 (TITLE) to layout 6 (BLANK) + explicit `paint_background`.
3. (🟡) Walk HTML with a DOM walker that emits per-run style (italic, bold, hyperlink, font); update `add_run` calls accordingly.
4. (🟡) Switch KPI row on slide 9 to JetBrains Mono.

## Re-verify
After re-export, run `verify_layout.py <deck.pptx>` — zero rail violations is the gate. Re-run this audit; expect 9 PASS / 1 PARTIAL or better.
```

That's the shape. Concrete evidence, severity per row, root causes pulled out, fixes ordered by severity, the gate for re-shipping.

---

## Concrete examples

### Example 1 — 12-slide investor deck audited cleanly

Input: `/deck` produced `index.html`; `/pptx-export` produced `out/acme-q3-board.pptx`. User says "verify the deck before I send it." Agent runs the extractor, scores the 10 checks, finds 2 🔴 (footer rail on slides 5 and 8) and 4 🟡 (italic loss across hero slides, hyperlinks lost on CTA slides), writes `audit-acme-q3-board.md` per the shape above. Reply: "Wrote `./audit-acme-q3-board.md` — two critical footer-rail crossings (slides 5, 8) and italic/hyperlinks not propagated. Three systemic fixes named; once the export script adopts them, re-run me and I expect green."

### Example 2 — patch audit for a follow-up export

Input: same deck, but the operator re-exported after applying fix #1 (Cursor). Agent re-runs the extractor, finds footer rail now clean, italic still missing (fix #3 not done yet). Updates `audit-acme-q3-board.md` with a new "Pass 2" section noting check #3 now PASSes; check #2 and #8 still FAIL. Reply: "Pass 2 — footer rail clean. Italic and hyperlinks still pending; re-run after fix #3 + #4."

---

## Anti-patterns

- **Auditing the HTML deck against the PPTX.** Stop. The HTML is ground truth. The audit only asks "is the PPTX faithful to the HTML?", never the inverse.
- **Patching slide-5 by lowering its body 0.2" without naming the systemic cause.** Stop. If you fix slide 5 by hand, you'll be back fixing slides 9, 11, 14 next. Name the rule (Cursor + footer rail), fix once.
- **Trusting the export script's intent over the dump.** Stop. Run the extractor. The PPTX on disk is the only truth; the script's stated intent doesn't bind.
- **Skipping the audit because "PowerPoint preview looks fine".** Stop. Preview anti-aliasing hides 1–2mm overflow; PDF export drops it; the projector reveals it on stage. The script doesn't miss what the eye does.
- **Italicizing CJK / Arabic / Hebrew runs.** Stop. Those scripts have no italic tradition; PowerPoint produces a mechanical slant that looks deformed. Detect script and skip italic for non-Latin runs.
- **Re-running the audit without re-extracting.** Stop. Every audit pass starts with a fresh `extract_pptx.py` run. Cached dumps go stale the moment the operator re-exports.
