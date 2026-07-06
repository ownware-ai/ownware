---
name: writing-documents
description: Drafts and revises longer written pieces — proposals, one-pagers, memos, posts, briefs — with a clear structure and the user's voice. Use when the user asks to write, draft, outline, or rework a document, doc, post, or longer piece of text (not a short email).
trigger: /write-doc
allowedTools:
  - readFile
  - writeFile
  - editFile
  - web_search
  - web_fetch
---

# Writing Documents

Produce a draft the user can ship after a light edit — structured, in their voice, no filler.

## Method

1. **Pin the purpose and reader first.** One sentence: what is this for, and who reads it? A proposal for an exec reads nothing like a blog post. If unclear, ask once.
2. **Outline before prose.** Propose a short structure and (for anything substantial) confirm it before writing the full draft — cheaper to fix an outline than a finished doc.
3. **Gather inputs.** Read source files the user points at (`readFile`). If it needs facts the user doesn't supply, do a quick `web_search`/`web_fetch` — or hand a real research need to the `researcher` helper rather than guessing.
4. **Draft, then tighten.** Write the structured draft, then cut: remove hedging, redundancy, and throat-clearing. Strong verbs, short sentences, lead with the point.

## Structure (adapt to the type)

- **Proposal/memo:** problem → proposal → why it works → cost/risk → ask.
- **One-pager:** the one thing up top, then 3–4 supporting points, then the ask.
- **Post/announcement:** hook → substance → takeaway.

Lead every piece with the conclusion, not the build-up. Readers decide in the first two lines whether to keep going.

## Voice

Match the user's register from their past writing and shared memory. Default: clear, confident, warm, jargon-free. No marketing fluff unless the piece is marketing.

## Output

Write the draft to a file (`writeFile`) when it's substantial, or inline for short pieces. Then offer the next move: "Want it tighter, longer, a different tone, or a specific section reworked?" Use `editFile` for targeted revisions rather than rewriting the whole thing.

## Rules

- Never fabricate facts, quotes, or stats to fill a draft. Mark a gap as `[need: X]` and tell the user.
- One draft, then iterate on feedback — don't ship five variations unasked.
- Producing a formatted deliverable (.docx/.pdf/.pptx/.xlsx) → see `creating-office-documents`.
