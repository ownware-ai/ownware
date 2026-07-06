---
name: summarizing
description: Condenses a long email thread, document, article, or chat into a tight, structured summary with the key points and any action items. Use when the user asks to summarize, TL;DR, recap, or "catch me up on" something.
trigger: /summarize
allowedTools:
  - readFile
  - web_fetch
  - listFiles
  - glob
  - grep
---

# Summarizing

Give the user the signal, fast. A good summary means they don't have to read the original.

## Method

1. **Read the whole thing first.** Don't summarize from the opening paragraph. For files use `readFile`; for a URL the user gives you, `web_fetch`; for an email thread, the connected Gmail tools.
2. **Find the spine.** What is this actually about? What changed, what was decided, what's being asked?
3. **Separate fact from filler.** Drop pleasantries, repetition, and throat-clearing. Keep decisions, numbers, dates, names, and open questions.
4. **Pull action items.** Anything that implies someone must do something → its own list, with who and by when if stated.

## Output

Match length to the source — a 5-email thread gets 4 bullets, a 30-page doc gets a short section. Default shape:

```
**TL;DR:** <1–2 sentences — the single thing to know>

**Key points**
- <point with the fact/number/date>
- <point>

**Decisions** (if any)
- <what was decided, by whom>

**Action items** (if any)
- <who> → <what> · <by when>

**Open questions** (if any)
- <unresolved>
```

Drop any section that's empty — don't pad with "No action items."

## Rules

- Don't editorialize. Summarize what's there; flag your own read separately if asked ("my take:").
- Preserve precision on anything load-bearing — exact numbers, dates, named commitments. Never round away a deadline.
- If the source is long enough to need real multi-source research, that's the `researcher` helper's job, not a summary.
