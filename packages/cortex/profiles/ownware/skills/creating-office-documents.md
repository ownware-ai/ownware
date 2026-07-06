---
name: creating-office-documents
description: Produces formatted office files — Word (.docx), PDF, PowerPoint (.pptx), and Excel (.xlsx) — from content the user provides or that you draft. Use when the user wants an actual document file, slide deck, spreadsheet, or PDF, not just text in chat.
trigger: /create-document
allowedTools:
  - readFile
  - writeFile
  - editFile
  - listFiles
  - glob
  - shell_execute
---

# Creating Office Documents

Turn content into a real, openable file — `.docx`, `.pdf`, `.pptx`, or `.xlsx` — saved to the user's workspace.

## Decide the format first

- **Word (.docx)** — letters, reports, anything mostly prose meant to be edited.
- **PDF** — final, fixed-layout deliverables meant to be read/printed, not edited.
- **PowerPoint (.pptx)** — slides: few words per slide, one idea each.
- **Excel (.xlsx)** — tabular data, calculations, anything with rows/columns or a model.

If the user just needs the words and will format elsewhere, write Markdown/text instead — don't over-produce.

## How to build it

The robust path is a small script via `shell_execute` using a well-supported library, then verify the file opened:

- **.docx** → `python-docx` (or `docx` in Node)
- **.pdf** → render from Markdown/HTML (e.g. a Markdown→PDF tool) or `reportlab` for generated layouts
- **.xlsx** → `openpyxl` (Python) or `exceljs` (Node)
- **.pptx** → `python-pptx`

Workflow:

```
- [ ] Confirm format + where to save it
- [ ] Draft/collect the content (reuse writing-documents for prose, meeting-notes, etc.)
- [ ] Generate the file with a script (shell_execute)
- [ ] Verify it exists and is non-empty (listFiles); open-check if possible
- [ ] Tell the user the path and offer revisions
```

## Rules

- **Don't assume a library is installed.** Check first; if it's missing, install it project-scoped or tell the user what's needed — never fail silently.
- **Content quality comes from the other skills.** This skill is about *packaging* — lean on `writing-documents`, `meeting-notes`, or `summarizing` for the words, then format here.
- **Verify before claiming done.** A generated file that won't open is a failure. Confirm it's real and non-empty; say so.
- Keep slides sparse, spreadsheets clean (headers, no merged-cell chaos), PDFs final.

## Honest note

Rich, reliable office-file generation (complex tables, tracked changes, branded templates) is best done with dedicated, script-backed routines. This skill gives the working path; if the user needs heavy templating or fidelity, flag that a purpose-built generator is the stronger long-term answer rather than over-promising from a one-off script.
